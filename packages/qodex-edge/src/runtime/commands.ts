import type { CoreClient } from '../coreClient.js';
import type { QodexConfig } from '../config.js';
import type {
  ApprovalDecision,
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
    case '/approve': {
      const approvalId = rest[0];
      const decision = rest[1] === 'session' ? 'acceptForSession' : 'accept';
      await deps.resolveApproval(conversationKey, approvalId, decision, sink);
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
