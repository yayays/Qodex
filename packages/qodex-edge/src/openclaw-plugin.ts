import { CoreClient } from './coreClient.js';
import {
  ApprovalRequestedEvent,
  ConversationCompletedEvent,
  ConversationDeltaEvent,
  ConversationErrorEvent,
  ConversationRef,
  ConversationStatusResponse,
  CoreEvents,
  PendingApprovalRecord,
  SenderRef,
} from './core-protocol.js';

const PLUGIN_ID = 'qodex';
const DEFAULT_CORE_URL = 'ws://127.0.0.1:7820/ws';
const DEFAULT_RESPONSE_TIMEOUT_MS = 90_000;
const DEFAULT_PLATFORM = 'qqbot';

type JsonObject = Record<string, unknown>;

interface OpenClawPluginApi {
  registerCommand(command: OpenClawCommand): void;
}

interface OpenClawCommand {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (context: OpenClawCommandContext) => Promise<OpenClawCommandResult>;
}

interface OpenClawCommandResult {
  text: string;
}

export interface OpenClawCommandContext {
  senderId?: string;
  channel?: string;
  args?: string;
  commandBody?: string;
  config?: unknown;
  [key: string]: unknown;
}

interface ResolvedPluginConfig {
  coreUrl: string;
  coreAuthToken?: string;
  defaultWorkspace?: string;
  responseTimeoutMs: number;
}

interface TurnMatch {
  conversationKey: string;
  threadId?: string | null;
  turnId?: string | null;
}

type TurnOutcome =
  | {
      kind: 'completed';
      text: string;
    }
  | {
      kind: 'approval';
      event: ApprovalRequestedEvent;
      partialText: string;
    }
  | {
      kind: 'error';
      message: string;
      partialText: string;
    }
  | {
      kind: 'timeout';
      partialText: string;
    };

export const qodexPluginConfigSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    coreUrl: {
      type: 'string',
      description: 'WebSocket endpoint exposed by qodex-core.',
      default: DEFAULT_CORE_URL,
    },
    coreAuthToken: {
      type: 'string',
      description: 'Optional bearer token for connecting to qodex-core.',
    },
    defaultWorkspace: {
      type: 'string',
      description: 'Workspace sent on the first turn when a conversation is not bound yet.',
    },
    responseTimeoutMs: {
      type: 'integer',
      description: 'Maximum time to wait for a turn result before returning a timeout message.',
      default: DEFAULT_RESPONSE_TIMEOUT_MS,
      minimum: 1_000,
    },
  },
} as const;

export const qodexOpenClawPlugin = {
  id: PLUGIN_ID,
  name: 'Qodex',
  description: 'Qodex commands for OpenClaw transports such as openclaw-qqbot.',
  configSchema: qodexPluginConfigSchema,
  register(api: OpenClawPluginApi): void {
    api.registerCommand({
      name: 'qodex',
      description: 'Send a prompt to qodex-core and wait for the backend reply.',
      acceptsArgs: true,
      requireAuth: true,
      handler: async (context) => {
        const prompt = getCommandArgs(context);
        if (!prompt) {
          return textResult(renderHelp(context));
        }

        const pluginConfig = resolvePluginConfig(context.config);
        const conversation = deriveConversation(context);
        const sender = deriveSender(context);

        const text = await withCoreClient(pluginConfig, async (client) => {
          const status = await client.status({
            conversationKey: conversation.conversationKey,
          });
          const workspace = shouldInjectDefaultWorkspace(status, pluginConfig.defaultWorkspace)
            ? pluginConfig.defaultWorkspace
            : undefined;

          return await sendPromptAndWait(client, {
            conversation,
            sender,
            text: prompt,
            workspace,
            timeoutMs: pluginConfig.responseTimeoutMs,
          });
        });

        return textResult(text);
      },
    });

    api.registerCommand({
      name: 'qodex-bind',
      description: 'Bind the current OpenClaw conversation to a workspace path.',
      acceptsArgs: true,
      requireAuth: true,
      handler: async (context) => {
        const workspace = getCommandArgs(context);
        if (!workspace) {
          return textResult('Usage: /qodex-bind /absolute/or/relative/workspace/path');
        }

        const pluginConfig = resolvePluginConfig(context.config);
        const conversation = deriveConversation(context);

        const text = await withCoreClient(pluginConfig, async (client) => {
          const status = await client.bindWorkspace({
            conversationKey: conversation.conversationKey,
            workspace,
          });
          return formatStatus('Workspace updated', conversation, status);
        });

        return textResult(text);
      },
    });

    api.registerCommand({
      name: 'qodex-status',
      description: 'Show the current Qodex workspace, thread, and pending approvals.',
      requireAuth: true,
      handler: async (context) => {
        const pluginConfig = resolvePluginConfig(context.config);
        const conversation = deriveConversation(context);

        const text = await withCoreClient(pluginConfig, async (client) => {
          const status = await client.status({
            conversationKey: conversation.conversationKey,
          });
          return formatStatus('Current state', conversation, status);
        });

        return textResult(text);
      },
    });

    api.registerCommand({
      name: 'qodex-new',
      description: 'Start a fresh backend thread for the current OpenClaw conversation.',
      requireAuth: true,
      handler: async (context) => {
        const pluginConfig = resolvePluginConfig(context.config);
        const conversation = deriveConversation(context);

        const text = await withCoreClient(pluginConfig, async (client) => {
          const status = await client.newThread({
            conversationKey: conversation.conversationKey,
          });
          return formatStatus('Thread reset', conversation, status);
        });

        return textResult(text);
      },
    });

    api.registerCommand({
      name: 'qodex-approve',
      description: 'Approve a pending Qodex action. Add "session" to grant the whole session.',
      acceptsArgs: true,
      requireAuth: true,
      handler: async (context) => {
        const [approvalId, mode] = splitArgs(getCommandArgs(context));
        if (!approvalId) {
          return textResult('Usage: /qodex-approve <approvalId> [session]');
        }

        const pluginConfig = resolvePluginConfig(context.config);
        const conversation = deriveConversation(context);

        const text = await withCoreClient(pluginConfig, async (client) => {
          const status = await client.status({
            conversationKey: conversation.conversationKey,
          });
          const approval = findApproval(status, approvalId);
          const decision = mode === 'session' ? 'acceptForSession' : 'accept';
          const waiter = approval
            ? createTurnOutcomeWaiter(
                client,
                {
                  conversationKey: approval.conversationKey,
                  threadId: approval.threadId,
                  turnId: approval.turnId,
                },
                pluginConfig.responseTimeoutMs,
              )
            : undefined;
          const response = await client.respondApproval({
            approvalId,
            decision,
          });

          if (!approval) {
            return `Approval ${response.approvalId} -> ${response.status}`;
          }

          if (!waiter) {
            return `Approval ${response.approvalId} -> ${response.status}`;
          }

          const outcome = await waiter.promise.finally(() => waiter.cancel());

          return [
            `Approval ${response.approvalId} -> ${response.status}`,
            '',
            formatTurnOutcome(outcome, pluginConfig.responseTimeoutMs),
          ].join('\n');
        });

        return textResult(text);
      },
    });

    api.registerCommand({
      name: 'qodex-reject',
      description: 'Reject a pending Qodex approval request.',
      acceptsArgs: true,
      requireAuth: true,
      handler: async (context) => {
        const approvalId = getCommandArgs(context);
        if (!approvalId) {
          return textResult('Usage: /qodex-reject <approvalId>');
        }

        const pluginConfig = resolvePluginConfig(context.config);

        const text = await withCoreClient(pluginConfig, async (client) => {
          const response = await client.respondApproval({
            approvalId,
            decision: 'decline',
          });
          return `Approval ${response.approvalId} -> ${response.status}`;
        });

        return textResult(text);
      },
    });
  },
};

export default qodexOpenClawPlugin;

function textResult(text: string): OpenClawCommandResult {
  return { text };
}

async function withCoreClient<T>(
  pluginConfig: ResolvedPluginConfig,
  callback: (client: CoreClient) => Promise<T>,
): Promise<T> {
  const client = new CoreClient(pluginConfig.coreUrl, {
    authToken: pluginConfig.coreAuthToken,
    requestTimeoutMs: pluginConfig.responseTimeoutMs,
  });
  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForTurnOutcome(
  client: CoreClient,
  match: TurnMatch,
  timeoutMs: number,
): Promise<TurnOutcome> {
  const waiter = createTurnOutcomeWaiter(client, match, timeoutMs);
  try {
    return await waiter.promise;
  } finally {
    waiter.cancel();
  }
}

async function sendPromptAndWait(
  client: CoreClient,
  options: {
    conversation: ConversationRef;
    sender: SenderRef;
    text: string;
    workspace?: string;
    timeoutMs: number;
  },
): Promise<string> {
  const match: TurnMatch = {
    conversationKey: options.conversation.conversationKey,
  };
  const waiter = createTurnOutcomeWaiter(client, match, options.timeoutMs);

  try {
    const response = await client.sendMessage({
      conversation: options.conversation,
      sender: options.sender,
      text: options.text,
      workspace: options.workspace,
    });

    match.threadId = response.threadId;
    match.turnId = response.turnId;

    const outcome = await waiter.promise;
    return formatTurnOutcome(outcome, options.timeoutMs);
  } finally {
    waiter.cancel();
  }
}

function createTurnOutcomeWaiter(
  client: CoreClient,
  match: TurnMatch,
  timeoutMs: number,
): {
  promise: Promise<TurnOutcome>;
  cancel: () => void;
} {
  let partialText = '';
  let cleanedUp = false;
  let timeoutId: NodeJS.Timeout | undefined;
  const onDelta = (event: ConversationDeltaEvent): void => {
    if (!matchesTurn(match, event.conversationKey, event.threadId, event.turnId)) {
      return;
    }
    partialText += event.delta;
  };
  const onCompleted = (event: ConversationCompletedEvent): void => {
    if (!matchesTurn(match, event.conversationKey, event.threadId, event.turnId)) {
      return;
    }
    finish({
      kind: 'completed',
      text: event.text || partialText.trim() || '[Qodex completed with an empty response]',
    });
  };
  const onError = (event: ConversationErrorEvent): void => {
    if (!matchesError(match, event)) {
      return;
    }
    finish({
      kind: 'error',
      message: event.message,
      partialText: partialText.trim(),
    });
  };
  const onApproval = (event: ApprovalRequestedEvent): void => {
    if (!matchesTurn(match, event.conversationKey, event.threadId, event.turnId)) {
      return;
    }
    finish({
      kind: 'approval',
      event,
      partialText: partialText.trim(),
    });
  };

  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    client.off(CoreEvents.delta, onDelta);
    client.off(CoreEvents.completed, onCompleted);
    client.off(CoreEvents.error, onError);
    client.off(CoreEvents.approvalRequested, onApproval);
  };

  let finish: (outcome: TurnOutcome) => void = cleanup;
  const promise = new Promise<TurnOutcome>((resolve) => {
    finish = (outcome: TurnOutcome): void => {
      cleanup();
      resolve(outcome);
    };
    timeoutId = setTimeout(() => {
      finish({
        kind: 'timeout',
        partialText: partialText.trim(),
      });
    }, timeoutMs);

    client.on(CoreEvents.delta, onDelta);
    client.on(CoreEvents.completed, onCompleted);
    client.on(CoreEvents.error, onError);
    client.on(CoreEvents.approvalRequested, onApproval);
  });

  return { promise, cancel: cleanup };
}

function formatTurnOutcome(outcome: TurnOutcome, timeoutMs: number): string {
  switch (outcome.kind) {
    case 'completed':
      return outcome.text;
    case 'approval':
      return [
        outcome.partialText || undefined,
        `Approval requested: ${outcome.event.approvalId}`,
        `kind=${outcome.event.kind}`,
        `summary=${outcome.event.summary}`,
        outcome.event.reason ? `reason=${outcome.event.reason}` : undefined,
        `Use /qodex-approve ${outcome.event.approvalId} or /qodex-reject ${outcome.event.approvalId}`,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n');
    case 'error':
      return [
        outcome.partialText || undefined,
        `Qodex error: ${outcome.message}`,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n');
    case 'timeout':
      return outcome.partialText
        ? [
            `Timed out after ${Math.round(timeoutMs / 1000)}s. Partial response:`,
            '',
            outcome.partialText,
          ].join('\n')
        : `Timed out after ${Math.round(timeoutMs / 1000)}s before Qodex returned a reply.`;
  }
}

function formatStatus(
  title: string,
  conversation: ConversationRef,
  status: ConversationStatusResponse,
): string {
  const lines = [title, `conversation=${conversation.conversationKey}`];

  if (!status.conversation) {
    lines.push('workspace=unbound');
    lines.push('thread=none');
  } else {
    lines.push(`workspace=${status.conversation.workspace}`);
    lines.push(`thread=${status.conversation.threadId ?? 'none'}`);
  }

  if (status.pendingApprovals.length === 0) {
    lines.push('pendingApprovals=0');
  } else {
    lines.push(
      `pendingApprovals=${status.pendingApprovals
        .map((approval) => `${approval.approvalId}:${approval.kind}`)
        .join(', ')}`,
    );
  }

  return lines.join('\n');
}

function renderHelp(context: OpenClawCommandContext): string {
  const conversation = deriveConversation(context);
  return [
    'Usage:',
    '/qodex <prompt>',
    '/qodex-bind <workspace>',
    '/qodex-status',
    '/qodex-new',
    '/qodex-approve <approvalId> [session]',
    '/qodex-reject <approvalId>',
    '',
    `conversation=${conversation.conversationKey}`,
  ].join('\n');
}

function resolvePluginConfig(rootConfig: unknown): ResolvedPluginConfig {
  const pluginConfig = resolvePluginConfigObject(rootConfig);

  return {
    coreUrl:
      readString(pluginConfig.coreUrl) ??
      process.env.QODEX_CORE_URL ??
      DEFAULT_CORE_URL,
    coreAuthToken:
      readString(pluginConfig.coreAuthToken) ?? process.env.QODEX_CORE_AUTH_TOKEN,
    defaultWorkspace:
      readString(pluginConfig.defaultWorkspace) ?? process.env.QODEX_DEFAULT_WORKSPACE,
    responseTimeoutMs:
      readPositiveInteger(pluginConfig.responseTimeoutMs) ??
      readPositiveInteger(process.env.QODEX_RESPONSE_TIMEOUT_MS) ??
      DEFAULT_RESPONSE_TIMEOUT_MS,
  };
}

function resolvePluginConfigObject(rootConfig: unknown): JsonObject {
  if (!isRecord(rootConfig)) {
    return {};
  }

  const directCandidate = hasPluginConfigShape(rootConfig) ? rootConfig : undefined;
  const pluginEntry = getNestedRecord(rootConfig, ['plugins', 'entries', PLUGIN_ID]);
  const entryConfig = pluginEntry ? getNestedRecord(pluginEntry, ['config']) : undefined;
  const namespaceConfig = getNestedRecord(rootConfig, [PLUGIN_ID]);

  return {
    ...(namespaceConfig ?? {}),
    ...(pluginEntry ?? {}),
    ...(entryConfig ?? {}),
    ...(directCandidate ?? {}),
  };
}

function hasPluginConfigShape(value: JsonObject): boolean {
  return (
    Object.prototype.hasOwnProperty.call(value, 'coreUrl') ||
    Object.prototype.hasOwnProperty.call(value, 'coreAuthToken') ||
    Object.prototype.hasOwnProperty.call(value, 'defaultWorkspace') ||
    Object.prototype.hasOwnProperty.call(value, 'responseTimeoutMs')
  );
}

function deriveConversation(context: OpenClawCommandContext): ConversationRef {
  const platform = sanitizeSegment(readString(context.channel)) ?? DEFAULT_PLATFORM;

  const hintedKey = pickFirstString(context, [
    ['conversationKey'],
    ['conversation', 'conversationKey'],
    ['conversationId'],
    ['conversation', 'id'],
    ['target'],
    ['targetId'],
    ['message', 'conversationKey'],
    ['message', 'conversationId'],
    ['message', 'target'],
    ['message', 'targetId'],
    ['event', 'conversationKey'],
    ['event', 'conversationId'],
    ['event', 'target'],
    ['event', 'targetId'],
    ['inbound', 'conversationKey'],
    ['inbound', 'conversationId'],
    ['inbound', 'target'],
    ['inbound', 'targetId'],
  ]);

  const normalizedHint = hintedKey ? normalizeConversationHint(hintedKey, platform) : undefined;
  if (normalizedHint) {
    return normalizedHint;
  }

  const groupId = sanitizeExternalId(
    pickFirstString(context, [
      ['groupId'],
      ['message', 'groupId'],
      ['event', 'groupId'],
    ]),
  );
  if (groupId) {
    return makeConversation(platform, 'group', groupId);
  }

  const scope =
    sanitizeSegment(
      pickFirstString(context, [
        ['scope'],
        ['chatType'],
        ['conversation', 'scope'],
        ['message', 'scope'],
        ['event', 'scope'],
      ]),
    ) ?? 'c2c';
  const senderId = sanitizeExternalId(readString(context.senderId)) ?? 'anonymous';
  return makeConversation(platform, scope, senderId);
}

function deriveSender(context: OpenClawCommandContext): SenderRef {
  return {
    senderId: sanitizeExternalId(readString(context.senderId)) ?? 'anonymous',
    displayName: pickFirstString(context, [
      ['senderName'],
      ['displayName'],
      ['sender', 'displayName'],
      ['sender', 'name'],
      ['user', 'name'],
      ['message', 'senderName'],
      ['event', 'senderName'],
    ]),
  };
}

function normalizeConversationHint(
  hint: string,
  fallbackPlatform: string,
): ConversationRef | undefined {
  const trimmed = hint.trim();
  const fullMatch = /^([a-z0-9_-]+):(c2c|group|channel):(.+)$/i.exec(trimmed);
  if (fullMatch) {
    const [, platform, scope, externalId] = fullMatch;
    return makeConversation(
      sanitizeSegment(platform) ?? fallbackPlatform,
      sanitizeSegment(scope) ?? 'c2c',
      sanitizeExternalId(externalId) ?? 'unknown',
    );
  }

  const scopeMatch = /^(c2c|group|channel):(.+)$/i.exec(trimmed);
  if (scopeMatch) {
    const [, scope, externalId] = scopeMatch;
    return makeConversation(
      fallbackPlatform,
      sanitizeSegment(scope) ?? 'c2c',
      sanitizeExternalId(externalId) ?? 'unknown',
    );
  }

  return undefined;
}

function shouldInjectDefaultWorkspace(
  status: ConversationStatusResponse,
  defaultWorkspace?: string,
): defaultWorkspace is string {
  if (!defaultWorkspace) {
    return false;
  }

  return !status.conversation?.workspace;
}

function matchesTurn(
  match: TurnMatch,
  conversationKey: string,
  threadId?: string | null,
  turnId?: string | null,
): boolean {
  if (conversationKey !== match.conversationKey) {
    return false;
  }
  if (match.threadId && threadId && match.threadId !== threadId) {
    return false;
  }
  if (match.turnId && turnId && match.turnId !== turnId) {
    return false;
  }
  return true;
}

function matchesError(match: TurnMatch, event: ConversationErrorEvent): boolean {
  if (event.conversationKey !== match.conversationKey) {
    return false;
  }
  if (match.threadId && event.threadId && match.threadId !== event.threadId) {
    return false;
  }
  if (match.turnId && event.turnId && match.turnId !== event.turnId) {
    return false;
  }
  return true;
}

function findApproval(
  status: ConversationStatusResponse,
  approvalId: string,
): PendingApprovalRecord | undefined {
  return status.pendingApprovals.find((approval) => approval.approvalId === approvalId);
}

function makeConversation(
  platform: string,
  scope: string,
  externalId: string,
): ConversationRef {
  return {
    conversationKey: `${platform}:${scope}:${externalId}`,
    platform,
    scope,
    externalId,
  };
}

function getCommandArgs(context: OpenClawCommandContext): string {
  return (
    readString(context.args) ??
    readString(context.commandBody) ??
    ''
  ).trim();
}

function splitArgs(input: string): string[] {
  return input
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function pickFirstString(source: unknown, paths: string[][]): string | undefined {
  for (const path of paths) {
    const value = getNestedValue(source, path);
    const text = readString(value);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function getNestedRecord(source: unknown, path: string[]): JsonObject | undefined {
  const value = getNestedValue(source, path);
  return isRecord(value) ? value : undefined;
}

function getNestedValue(source: unknown, path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function sanitizeSegment(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\s+/g, '-').replace(/:/g, '-');
}

function sanitizeExternalId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.trim().replace(/\s+/g, '_');
}
