import type { CoreClient } from '../coreClient.js';
import type { QodexConfig } from '../config.js';
import type {
  ApprovalDecision,
  MemoryContextResponse,
  MemoryProfileRecord,
  MemoryScopeType,
  OutboundSink,
  PlatformMessage,
} from '../protocol.js';
import {
  renderApprovalUsage,
  resolveApprovalId,
} from './approvals.js';
import {
  renderDetailedStatus,
  renderHelp,
  renderRunningState,
  renderStatus,
} from './rendering.js';
import type { RuntimeHostBridge } from '../runtime.js';
import type { RuntimeSessionState } from './state.js';

interface RuntimeCommandDeps {
  core: CoreClient;
  config: QodexConfig;
  host?: RuntimeHostBridge;
  sessionState: RuntimeSessionState;
  resolveBackendKind(message: PlatformMessage): QodexConfig['backend']['kind'];
  resolveApproval(
    conversationKey: string,
    approvalToken: string | undefined,
    decision: ApprovalDecision,
    sink: OutboundSink,
  ): Promise<void>;
}

export async function handleRuntimeCommand(
  deps: RuntimeCommandDeps,
  message: PlatformMessage,
  sink: OutboundSink,
): Promise<void> {
  const [command, ...rest] = message.text.trim().split(/\s+/);
  const argumentText = message.text.trim().slice(command.length).trim();
  const conversationKey = message.conversation.conversationKey;
  const messageBackendKind = deps.resolveBackendKind(message);

  switch (command) {
    case '/help': {
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: renderHelp(deps.config.backend.defaultWorkspace, messageBackendKind),
      });
      return;
    }
    case '/bind': {
      if (!argumentText) {
        await sink.sendText({
          conversationKey,
          kind: 'error',
          text: 'Usage: /bind /absolute/workspace/path',
        });
        return;
      }
      const status = await deps.core.bindWorkspace({
        conversationKey,
        workspace: argumentText,
        backendKind: messageBackendKind,
      });
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: renderStatus(
          'Workspace updated',
          status,
          deps.config.backend.defaultWorkspace,
          deps.sessionState.getProcessingState(conversationKey),
          status.conversation?.backendKind ?? messageBackendKind,
        ),
      });
      return;
    }
    case '/new': {
      const status = await deps.core.newThread({
        conversationKey,
        backendKind: messageBackendKind,
      });
      deps.sessionState.clearConversationTurns(conversationKey);
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: renderStatus(
          'Thread reset',
          status,
          deps.config.backend.defaultWorkspace,
          deps.sessionState.getProcessingState(conversationKey),
          status.conversation?.backendKind ?? messageBackendKind,
        ),
      });
      return;
    }
    case '/status': {
      const status = await deps.core.status({ conversationKey });
      const processing = deps.sessionState.getProcessingState(conversationKey);
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: renderStatus(
          'Current state',
          status,
          deps.config.backend.defaultWorkspace,
          processing,
          status.conversation?.backendKind ?? messageBackendKind,
        ),
      });
      return;
    }
    case '/status+': {
      const details = await deps.core.details({
        conversationKey,
        messageLimit: 6,
      });
      const processing = deps.sessionState.getProcessingState(conversationKey);
      const conversation = details.conversation ?? {
        conversationKey,
        platform: message.conversation.platform,
        scope: message.conversation.scope,
        externalId: message.conversation.externalId,
      };
      const channelHealth = deps.host?.listConversationChannels(conversation ?? null) ?? [];
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: renderDetailedStatus(
          details,
          processing,
          deps.config.backend.defaultWorkspace,
          channelHealth,
          details.conversation?.backendKind ?? messageBackendKind,
        ),
      });
      return;
    }
    case '/running': {
      const running = await deps.core.running({ conversationKey });
      const processing = deps.sessionState.getProcessingState(conversationKey);
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: renderRunningState(
          processing,
          running,
          running.conversation?.backendKind ?? messageBackendKind,
        ),
      });
      return;
    }
    case '/memory': {
      const memory = await deps.core.listMemory(buildMemoryLocator(message));
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: renderMemoryContext(memory),
      });
      return;
    }
    case '/remember': {
      const [scopeToken, category, ...contentParts] = rest;
      if (!scopeToken || !category || contentParts.length === 0) {
        await sink.sendText({
          conversationKey,
          kind: 'error',
          text: 'Usage: /remember <bot|workspace|user> <category> <content>',
        });
        return;
      }
      const scopeType = parseMemoryScope(scopeToken);
      if (!scopeType) {
        await sink.sendText({
          conversationKey,
          kind: 'error',
          text: 'Scope must be one of: bot, workspace, user',
        });
        return;
      }
      const response = await deps.core.rememberMemory({
        ...buildMemoryLocator(message),
        scopeType,
        category,
        content: contentParts.join(' '),
      });
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: [
          'Memory saved',
          `id=${response.fact.id}`,
          `scope=${scopeType}`,
          `category=${response.fact.category}`,
          `content=${response.fact.content}`,
        ].join('\n'),
      });
      return;
    }
    case '/forget': {
      const id = rest[0];
      if (!id) {
        await sink.sendText({
          conversationKey,
          kind: 'error',
          text: 'Usage: /forget <memoryId>',
        });
        return;
      }
      const response = await deps.core.forgetMemory({ id });
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: response.archived
          ? `Memory archived: ${response.id}`
          : `Memory not changed: ${response.id}`,
      });
      return;
    }
    case '/profile': {
      const explicitScope = rest[0] ? parseMemoryScope(rest[0]) : undefined;
      const scopeType = explicitScope ?? 'user';
      const assignments = explicitScope ? rest.slice(1) : rest;
      if (assignments.length === 0) {
        const response = await deps.core.getMemoryProfile({
          ...buildMemoryLocator(message),
          scopeType,
        });
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: renderSingleProfile(scopeType, response.profile ?? null),
        });
        return;
      }
      const current = await deps.core.getMemoryProfile({
        ...buildMemoryLocator(message),
        scopeType,
      });
      const profile = applyProfileAssignments(
        parseProfileJson(current.profile?.profileJson),
        assignments,
      );
      const updated = await deps.core.upsertMemoryProfile({
        ...buildMemoryLocator(message),
        scopeType,
        profile,
      });
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: renderSingleProfile(scopeType, updated.profile ?? null, 'Profile updated'),
      });
      return;
    }
    case '/summary': {
      if (!argumentText) {
        const response = await deps.core.getConversationSummary({ conversationKey });
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: renderConversationSummary(response.summary ?? null),
        });
        return;
      }
      if (argumentText === 'clear') {
        const response = await deps.core.clearConversationSummary({ conversationKey });
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: response.cleared
            ? 'Conversation summary cleared'
            : 'Conversation summary was already empty',
        });
        return;
      }
      const response = await deps.core.upsertConversationSummary({
        conversationKey,
        summaryText: argumentText,
      });
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: renderConversationSummary(response.summary ?? null, 'Conversation summary updated'),
      });
      return;
    }
    case '/hint': {
      const [scopeToken, ...hintParts] = rest;
      if (!scopeToken || hintParts.length === 0) {
        await sink.sendText({
          conversationKey,
          kind: 'error',
          text: 'Usage: /hint <bot|workspace|user> <text>',
        });
        return;
      }
      const scopeType = parseMemoryScope(scopeToken);
      if (!scopeType) {
        await sink.sendText({
          conversationKey,
          kind: 'error',
          text: 'Scope must be one of: bot, workspace, user',
        });
        return;
      }
      const response = await deps.core.addPromptHint({
        ...buildMemoryLocator(message),
        scopeType,
        hintText: hintParts.join(' '),
      });
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: [
          'Prompt hint saved',
          `id=${response.hint.id}`,
          `scope=${scopeType}`,
          `text=${response.hint.hintText}`,
        ].join('\n'),
      });
      return;
    }
    case '/unhint': {
      const id = rest[0];
      if (!id) {
        await sink.sendText({
          conversationKey,
          kind: 'error',
          text: 'Usage: /unhint <hintId>',
        });
        return;
      }
      const response = await deps.core.removePromptHint({ id });
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text: response.archived
          ? `Prompt hint archived: ${response.id}`
          : `Prompt hint not changed: ${response.id}`,
      });
      return;
    }
    case '/approve': {
      const approvalId = rest[0];
      const decision = rest[1] === 'session' ? 'acceptForSession' : 'accept';
      await deps.resolveApproval(conversationKey, approvalId, decision, sink);
      return;
    }
    case '/approveall': {
      const mode = (rest[0] ?? '').trim().toLowerCase();
      if (!mode) {
        const enabled = deps.sessionState.isAutoApprovePermissionsEnabled(
          conversationKey,
          deps.config.edge.autoApprovePermissions,
        );
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: enabled
            ? 'Auto-approve permissions is ON for this conversation.'
            : 'Auto-approve permissions is OFF for this conversation.',
        });
        return;
      }
      if (mode !== 'on' && mode !== 'off') {
        await sink.sendText({
          conversationKey,
          kind: 'error',
          text: 'Usage: /approveall [on|off]',
        });
        return;
      }
      const enabled = mode === 'on';
      deps.sessionState.setAutoApprovePermissions(conversationKey, enabled);

      if (!enabled) {
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: 'Auto-approve permissions disabled for this conversation.',
        });
        return;
      }

      const result = await resolveRuntimeApprovalsByKind(
        deps.core,
        conversationKey,
        'permissions',
        'accept',
      );
      await sink.sendText({
        conversationKey,
        kind: 'system',
        text:
          result.resolvedCount > 0
            ? `Auto-approve permissions enabled. Approved ${result.resolvedCount} pending permission request(s).`
            : 'Auto-approve permissions enabled. Future permission requests will be approved automatically.',
      });
      return;
    }
    case '/reject': {
      const approvalId = rest[0];
      await deps.resolveApproval(conversationKey, approvalId, 'decline', sink);
      return;
    }
    default:
      await sink.sendText({
        conversationKey,
        kind: 'error',
        text: `Unknown command: ${command}`,
      });
  }
}

function buildMemoryLocator(message: PlatformMessage) {
  return {
    conversationKey: message.conversation.conversationKey,
    botInstance: message.conversation.platform,
    workspace: message.workspace,
    userKey: `${message.conversation.platform}:${message.conversation.scope}:${message.sender.senderId}`,
  };
}

function parseMemoryScope(value: string): MemoryScopeType | undefined {
  switch (value.trim().toLowerCase()) {
    case 'bot':
      return 'botInstance';
    case 'workspace':
      return 'workspace';
    case 'user':
      return 'user';
    default:
      return undefined;
  }
}

function renderMemoryContext(memory: MemoryContextResponse): string {
  const lines = ['Active memory'];
  const scopes = [
    memory.link?.botInstance ? `bot=${memory.link.botInstance}` : undefined,
    memory.link?.workspace ? `workspace=${memory.link.workspace}` : undefined,
    memory.link?.userKey ? `user=${memory.link.userKey}` : undefined,
  ].filter(Boolean);
  lines.push(`scopes=${scopes.length > 0 ? scopes.join(', ') : 'none'}`);

  if (memory.conversationSummary) {
    lines.push(`summary=${memory.conversationSummary.summaryText}`);
  } else {
    lines.push('summary=empty');
  }

  if (memory.profiles.length === 0) {
    lines.push('profiles=0');
  } else {
    lines.push('profiles:');
    for (const profile of memory.profiles) {
      lines.push(`- ${renderProfileLine(profile)}`);
    }
  }

  if (memory.promptHints.length === 0) {
    lines.push('promptHints=0');
  } else {
    lines.push('promptHints:');
    for (const hint of memory.promptHints) {
      lines.push(`- ${hint.id} ${hint.scopeType} ${hint.hintText}`);
    }
  }

  if (memory.facts.length === 0) {
    lines.push('facts=0');
  } else {
    lines.push('facts:');
    for (const fact of memory.facts) {
      lines.push(`- ${fact.id} ${fact.scopeType} [${fact.category}] ${fact.content}`);
    }
  }

  return lines.join('\n');
}

function renderSingleProfile(
  scopeType: MemoryScopeType,
  profile: MemoryProfileRecord | null,
  title = 'Profile',
): string {
  if (!profile) {
    return `${title}\nscope=${scopeType}\nprofile=empty`;
  }
  return [
    title,
    `scope=${scopeType}`,
    `version=${profile.version}`,
    `values=${renderProfileJson(parseProfileJson(profile.profileJson))}`,
  ].join('\n');
}

function renderProfileLine(profile: MemoryProfileRecord): string {
  return `${profile.scopeType} v${profile.version} ${renderProfileJson(parseProfileJson(profile.profileJson))}`;
}

function renderConversationSummary(
  summary: { summaryText: string; version: number } | null,
  title = 'Conversation summary',
): string {
  if (!summary) {
    return `${title}\nsummary=empty`;
  }
  return [title, `version=${summary.version}`, `text=${summary.summaryText}`].join('\n');
}

function renderProfileJson(profile: Record<string, unknown>): string {
  return Object.keys(profile).length === 0 ? 'empty' : JSON.stringify(profile);
}

function applyProfileAssignments(
  profile: Record<string, unknown>,
  assignments: string[],
): Record<string, unknown> {
  const nextProfile = structuredClone(profile);
  for (const item of assignments) {
    if (!item) {
      continue;
    }
    if (item.startsWith('!')) {
      deletePath(nextProfile, item.slice(1));
      continue;
    }
    const appendOperator = item.indexOf('+=');
    if (appendOperator > 0) {
      appendProfileValue(
        nextProfile,
        item.slice(0, appendOperator),
        parseScalarValue(item.slice(appendOperator + 2).trim()),
      );
      continue;
    }
    const removeOperator = item.indexOf('-=');
    if (removeOperator > 0) {
      removeProfileValue(
        nextProfile,
        item.slice(0, removeOperator),
        parseScalarValue(item.slice(removeOperator + 2).trim()),
      );
      continue;
    }
    const separator = item.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    assignProfileValue(
      nextProfile,
      item.slice(0, separator),
      parseScalarValue(item.slice(separator + 1).trim()),
    );
  }
  return nextProfile;
}

function parseProfileJson(profileJson: string | undefined): Record<string, unknown> {
  if (!profileJson) {
    return {};
  }
  try {
    const value = JSON.parse(profileJson) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseScalarValue(value: string): unknown {
  if (value === 'null') {
    return null;
  }
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // Fall through to string parsing for malformed inline JSON.
    }
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && value.trim() !== '') {
    return asNumber;
  }
  return value;
}

function assignProfileValue(profile: Record<string, unknown>, path: string, value: unknown): void {
  const target = resolveProfilePath(profile, path, true);
  if (!target) {
    return;
  }
  target.parent[target.key] = value;
}

function appendProfileValue(profile: Record<string, unknown>, path: string, value: unknown): void {
  const target = resolveProfilePath(profile, path, true);
  if (!target) {
    return;
  }
  const current = target.parent[target.key];
  if (Array.isArray(current)) {
    current.push(value);
    return;
  }
  target.parent[target.key] = current === undefined ? [value] : [current, value];
}

function removeProfileValue(profile: Record<string, unknown>, path: string, value: unknown): void {
  const target = resolveProfilePath(profile, path, false);
  if (!target || !Array.isArray(target.parent[target.key])) {
    return;
  }
  target.parent[target.key] = (target.parent[target.key] as unknown[]).filter((entry) => {
    return JSON.stringify(entry) !== JSON.stringify(value);
  });
}

function deletePath(profile: Record<string, unknown>, path: string): void {
  const target = resolveProfilePath(profile, path, false);
  if (!target) {
    return;
  }
  if (Array.isArray(target.parent) && typeof target.key === 'number') {
    target.parent.splice(target.key, 1);
    return;
  }
  delete target.parent[target.key];
}

function resolveProfilePath(
  root: Record<string, unknown>,
  path: string,
  createParents: boolean,
): { parent: any; key: string | number } | null {
  const segments = parseProfilePath(path);
  if (segments.length === 0) {
    return null;
  }
  let current: any = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const nextSegment = segments[index + 1];
    const currentValue = current[segment as any];
    if (currentValue === undefined) {
      if (!createParents) {
        return null;
      }
      current[segment as any] = typeof nextSegment === 'number' ? [] : {};
    } else if (typeof currentValue !== 'object' || currentValue === null) {
      if (!createParents) {
        return null;
      }
      current[segment as any] = typeof nextSegment === 'number' ? [] : {};
    }
    current = current[segment as any];
  }
  return { parent: current, key: segments.at(-1)! };
}

function parseProfilePath(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  for (const token of path.trim().split('.')) {
    if (!token) {
      continue;
    }
    const matches = token.matchAll(/([^[\]]+)|\[(\d+)\]/g);
    for (const match of matches) {
      if (match[1]) {
        segments.push(match[1]);
      } else if (match[2]) {
        segments.push(Number(match[2]));
      }
    }
  }
  return segments;
}

export async function resolveRuntimeApproval(
  core: CoreClient,
  conversationKey: string,
  approvalToken: string | undefined,
  decision: ApprovalDecision,
  sink: OutboundSink,
): Promise<void> {
  const status = await core.status({ conversationKey });
  const approvalId = resolveApprovalId(status.pendingApprovals, approvalToken);
  if (!approvalId) {
    await sink.sendText({
      conversationKey,
      kind: 'error',
      text: renderApprovalUsage(status.pendingApprovals),
    });
    return;
  }

  const response = await core.respondApproval({ approvalId, decision });
  await sink.sendText({
    conversationKey,
    kind: 'system',
    text: `Approval ${response.approvalId} -> ${response.status}`,
  });
}

async function resolveRuntimeApprovalsByKind(
  core: CoreClient,
  conversationKey: string,
  kind: string,
  decision: ApprovalDecision,
): Promise<{ resolvedCount: number }> {
  const status = await core.status({ conversationKey });
  const approvals = status.pendingApprovals.filter((approval) => approval.kind === kind);
  for (const approval of approvals) {
    await core.respondApproval({
      approvalId: approval.approvalId,
      decision,
    });
  }
  return { resolvedCount: approvals.length };
}
