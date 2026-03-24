import type { CoreClient } from '../coreClient.js';
import type { QodexConfig } from '../config.js';
import type { QodexLogger } from '../logger.js';
import type {
  ApprovalRequestedEvent,
  ConversationCompletedEvent,
  ConversationDeltaEvent,
  ConversationErrorEvent,
  OutboundSink,
} from '../protocol.js';
import { renderApprovalRequest } from './approvals.js';
import type { RuntimeSessionState } from './state.js';

export interface RuntimePresenterDeps {
  core: CoreClient;
  logger: QodexLogger;
  config: QodexConfig;
  sessionState: RuntimeSessionState;
  resolveSink(conversationKey: string): OutboundSink | undefined;
  isFailedTurnStatus(status: string): boolean;
}

export class RuntimeEventPresenter {
  constructor(private readonly deps: RuntimePresenterDeps) {}

  async handleDelta(event: ConversationDeltaEvent): Promise<void> {
    this.deps.sessionState.appendDelta(event.conversationKey, event.turnId, event.delta);
    const sink = this.deps.resolveSink(event.conversationKey);
    if (!sink?.sendStreamUpdate) {
      return;
    }

    const now = Date.now();
    const current = this.deps.sessionState.appendDelta(event.conversationKey, event.turnId, '');

    if (now - current.lastFlushAt >= this.deps.config.edge.streamFlushMs) {
      await sink.sendStreamUpdate({
        conversationKey: event.conversationKey,
        kind: 'stream',
        turnId: event.turnId,
        text: current.text,
      });
      this.deps.sessionState.markStreamFlushed(event.conversationKey, event.turnId, now);
    }

    this.deps.sessionState.pruneIdleState();
  }

  async handleCompleted(event: ConversationCompletedEvent): Promise<void> {
    const failed = this.deps.sessionState.clearTurn(event.conversationKey, event.turnId)
      || this.deps.isFailedTurnStatus(event.status);
    if (failed) {
      this.deps.logger.warn(
        {
          conversationKey: event.conversationKey,
          turnId: event.turnId,
          status: event.status,
        },
        'suppressing final message for failed turn',
      );
      await this.ackDeliveryIfPresent(event.eventId);
      this.deps.sessionState.pruneIdleState();
      return;
    }

    const sink = this.deps.resolveSink(event.conversationKey);
    if (!sink) {
      this.deps.sessionState.pruneIdleState();
      return;
    }

    await sink.sendText({
      conversationKey: event.conversationKey,
      kind: 'final',
      text: event.text || `[Qodex completed turn ${event.turnId} with empty text]`,
    });
    await this.ackDeliveryIfPresent(event.eventId);
    this.deps.sessionState.pruneIdleState();
  }

  async handleError(event: ConversationErrorEvent): Promise<void> {
    if (!event.conversationKey) {
      this.deps.logger.error({ event }, 'core reported an unbound error');
      return;
    }

    if (event.turnId) {
      this.deps.sessionState.markTurnFailed(event.conversationKey, event.turnId);
    }

    const sink = this.deps.resolveSink(event.conversationKey);
    if (!sink) {
      this.deps.sessionState.pruneIdleState();
      return;
    }

    await sink.sendText({
      conversationKey: event.conversationKey,
      kind: 'error',
      text: event.message,
    });
    await this.ackDeliveryIfPresent(event.eventId);
    this.deps.sessionState.pruneIdleState();
  }

  async handleApproval(event: ApprovalRequestedEvent): Promise<void> {
    if (
      event.kind === 'permissions'
      && this.deps.sessionState.isAutoApprovePermissionsEnabled(
        event.conversationKey,
        this.deps.config.edge.autoApprovePermissions,
      )
    ) {
      try {
        const response = await this.deps.core.respondApproval({
          approvalId: event.approvalId,
          decision: 'accept',
        });
        const sink = this.deps.resolveSink(event.conversationKey);
        if (sink) {
          await sink.sendText({
            conversationKey: event.conversationKey,
            kind: 'system',
            text: `Auto-approved permission request: ${response.approvalId}`,
          });
        }
        await this.ackDeliveryIfPresent(event.eventId);
        this.deps.sessionState.pruneIdleState();
        return;
      } catch (error) {
        this.deps.logger.warn(
          { approvalId: event.approvalId, conversationKey: event.conversationKey, error },
          'failed to auto-approve permission request',
        );
      }
    }

    const sink = this.deps.resolveSink(event.conversationKey);
    if (!sink) {
      this.deps.logger.warn({ event }, 'approval requested for conversation without sink');
      return;
    }

    await sink.sendText({
      conversationKey: event.conversationKey,
      kind: 'approval',
      text: renderApprovalRequest(event),
    });
    await this.ackDeliveryIfPresent(event.eventId);
    this.deps.sessionState.pruneIdleState();
  }

  private async ackDeliveryIfPresent(eventId: string | null | undefined): Promise<void> {
    if (!eventId) {
      return;
    }

    try {
      await this.deps.core.ackDelivery({ eventId });
    } catch (error) {
      this.deps.logger.warn({ eventId, error }, 'failed to acknowledge recoverable delivery');
    }
  }
}
