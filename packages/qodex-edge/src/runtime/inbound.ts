import type { CoreClient } from '../coreClient.js';
import type { QodexConfig } from '../config.js';
import type { QodexLogger } from '../logger.js';
import type {
  ApprovalDecision,
  OutboundSink,
  PlatformMessage,
} from '../protocol.js';
import { parseApprovalIntent } from './approvals.js';
import { handleRuntimeCommand } from './commands.js';
import { resolveQuickReply } from './utils.js';
import type { RuntimeSessionState } from './state.js';
import type { RuntimeHostBridge } from '../runtime.js';

export interface RuntimeInboundDeps {
  core: CoreClient;
  logger: QodexLogger;
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

export class RuntimeInboundHandler {
  constructor(private readonly deps: RuntimeInboundDeps) {}

  async handleIncoming(message: PlatformMessage, sink: OutboundSink): Promise<void> {
    this.deps.sessionState.rememberSink(message.conversation.conversationKey, sink);
    this.deps.sessionState.pruneIdleState();
    const trimmed = message.text.trim();
    const conversationKey = message.conversation.conversationKey;

    try {
      if (trimmed.startsWith('/')) {
        await handleRuntimeCommand(
          {
            core: this.deps.core,
            config: this.deps.config,
            host: this.deps.host,
            sessionState: this.deps.sessionState,
            resolveBackendKind: (platformMessage) => this.deps.resolveBackendKind(platformMessage),
            resolveApproval: (key, approvalToken, decision, outboundSink) =>
              this.deps.resolveApproval(key, approvalToken, decision, outboundSink),
          },
          message,
          sink,
        );
        return;
      }

      const approvalIntent = parseApprovalIntent(trimmed);
      if (approvalIntent) {
        await this.deps.resolveApproval(
          conversationKey,
          approvalIntent.approvalToken,
          approvalIntent.decision,
          sink,
        );
        return;
      }

      const quickReply = resolveQuickReply(trimmed);
      if (quickReply) {
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: quickReply,
        });
        return;
      }

      const response = await this.deps.core.sendMessage({
        conversation: message.conversation,
        sender: message.sender,
        text: message.text,
        images: message.images,
        workspace: message.workspace,
        backendKind: this.deps.resolveBackendKind(message),
        model: message.codex?.model,
        modelProvider: message.codex?.modelProvider,
      });
      this.deps.sessionState.registerActiveTurn(
        message.conversation.conversationKey,
        response.turnId,
      );

      if (sink.showAcceptedAck) {
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: `Qodex accepted message. thread=${response.threadId} turn=${response.turnId}`,
        });
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(
        {
          conversationKey,
          error,
        },
        'failed to handle inbound message',
      );
      await sink.sendText({
        conversationKey,
        kind: 'error',
        text: `Qodex error: ${messageText}`,
      });
    }
  }
}
