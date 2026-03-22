import { CoreClient } from './coreClient.js';
import { QodexConfig } from './config.js';
import { QodexLogger } from './logger.js';
import {
  ApprovalDecision,
  ApprovalRequestedEvent,
  ConversationCompletedEvent,
  ConversationDeltaEvent,
  ConversationErrorEvent,
  ConversationRef,
  CoreEvents,
  PendingDeliveryRecord,
} from './core-protocol.js';
import {
  OutboundSink,
  PlatformMessage,
  StreamUpdateMessage,
} from './platform-protocol.js';
import {
  parseApprovalIntent,
  renderApprovalRequest,
} from './runtime/approvals.js';
import { handleRuntimeCommand, resolveRuntimeApproval } from './runtime/commands.js';
import type { RuntimeChannelHealth } from './runtime/types.js';
import {
  isFailedTurnStatus,
  parseRecoverablePayload,
  resolveQuickReply,
} from './runtime/utils.js';
import { RuntimeSessionState } from './runtime/state.js';

export interface RuntimeHostBridge {
  resolveSinkForConversation(conversation: ConversationRef): OutboundSink | undefined;
  listConversationChannels(conversation?: ConversationRef | null): RuntimeChannelHealth[];
}

export class QodexEdgeRuntime {
  private readonly core: CoreClient;
  private readonly logger: QodexLogger;
  private readonly config: QodexConfig;
  private readonly sessionState = new RuntimeSessionState();
  private host?: RuntimeHostBridge;

  constructor(core: CoreClient, logger: QodexLogger, config: QodexConfig) {
    this.core = core;
    this.logger = logger;
    this.config = config;
  }

  attachHost(host: RuntimeHostBridge): void {
    this.host = host;
  }

  async start(): Promise<void> {
    await this.core.connect();
    this.core.on(CoreEvents.delta, (payload: ConversationDeltaEvent) => {
      void this.handleDelta(payload);
    });
    this.core.on(CoreEvents.completed, (payload: ConversationCompletedEvent) => {
      void this.handleCompleted(payload);
    });
    this.core.on(CoreEvents.error, (payload: ConversationErrorEvent) => {
      void this.handleError(payload);
    });
    this.core.on(CoreEvents.approvalRequested, (payload: ApprovalRequestedEvent) => {
      void this.handleApproval(payload);
    });
    this.logger.info({ coreUrl: this.config.edge.coreUrl }, 'connected to qodex-core');
  }

  async recoverPendingDeliveries(): Promise<void> {
    const { pending } = await this.core.listPendingDeliveries();
    if (pending.length === 0) {
      return;
    }

    let recovered = 0;
    for (const delivery of pending) {
      try {
        await this.replayPendingDelivery(delivery);
        recovered += 1;
      } catch (error) {
        this.logger.warn({ delivery, error }, 'failed to replay pending delivery');
      }
    }

    this.logger.info(
      { pending: pending.length, recovered },
      'processed recoverable qodex deliveries after startup',
    );
  }

  async handleIncoming(message: PlatformMessage, sink: OutboundSink): Promise<void> {
    this.sessionState.rememberSink(message.conversation.conversationKey, sink);
    this.sessionState.pruneIdleState();
    const trimmed = message.text.trim();
    const conversationKey = message.conversation.conversationKey;

    try {
      if (trimmed.startsWith('/')) {
        await this.handleCommand(message, sink);
        return;
      }

      const approvalIntent = parseApprovalIntent(trimmed);
      if (approvalIntent) {
        await this.resolveApproval(
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

      const response = await this.core.sendMessage({
        conversation: message.conversation,
        sender: message.sender,
        text: message.text,
        images: message.images,
        workspace: message.workspace,
        backendKind: this.resolveBackendKind(message),
        model: message.codex?.model,
        modelProvider: message.codex?.modelProvider,
      });
      this.sessionState.registerActiveTurn(message.conversation.conversationKey, response.turnId);

      if (sink.showAcceptedAck) {
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: `Qodex accepted message. thread=${response.threadId} turn=${response.turnId}`,
        });
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.logger.error(
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

  private async handleCommand(message: PlatformMessage, sink: OutboundSink): Promise<void> {
    await handleRuntimeCommand(
      {
        core: this.core,
        config: this.config,
        host: this.host,
        sessionState: this.sessionState,
        resolveBackendKind: (platformMessage) => this.resolveBackendKind(platformMessage),
        resolveApproval: (conversationKey, approvalToken, decision, outboundSink) =>
          this.resolveApproval(conversationKey, approvalToken, decision, outboundSink),
      },
      message,
      sink,
    );
  }

  private resolveBackendKind(message: PlatformMessage): QodexConfig['backend']['kind'] {
    return message.backendKind ?? this.config.backend.kind;
  }

  private async resolveApproval(
    conversationKey: string,
    approvalToken: string | undefined,
    decision: ApprovalDecision,
    sink: OutboundSink,
  ): Promise<void> {
    await resolveRuntimeApproval(this.core, conversationKey, approvalToken, decision, sink);
  }

  private async handleDelta(event: ConversationDeltaEvent): Promise<void> {
    this.sessionState.appendDelta(event.conversationKey, event.turnId, event.delta);
    const sink = this.resolveSink(event.conversationKey);
    if (!sink?.sendStreamUpdate) {
      return;
    }

    const now = Date.now();
    const current = this.sessionState.appendDelta(event.conversationKey, event.turnId, '');

    if (now - current.lastFlushAt >= this.config.edge.streamFlushMs) {
      const payload: StreamUpdateMessage = {
        conversationKey: event.conversationKey,
        kind: 'stream',
        turnId: event.turnId,
        text: current.text,
      };
      await sink.sendStreamUpdate(payload);
      this.sessionState.markStreamFlushed(event.conversationKey, event.turnId, now);
    }

    this.sessionState.pruneIdleState();
  }

  private async handleCompleted(event: ConversationCompletedEvent): Promise<void> {
    const failed = this.sessionState.clearTurn(event.conversationKey, event.turnId)
      || isFailedTurnStatus(event.status);
    if (failed) {
      this.logger.warn(
        {
          conversationKey: event.conversationKey,
          turnId: event.turnId,
          status: event.status,
        },
        'suppressing final message for failed turn',
      );
      await this.ackDeliveryIfPresent(event.eventId);
      this.sessionState.pruneIdleState();
      return;
    }

    const sink = this.resolveSink(event.conversationKey);
    if (!sink) {
      this.sessionState.pruneIdleState();
      return;
    }

    await sink.sendText({
      conversationKey: event.conversationKey,
      kind: 'final',
      text: event.text || `[Qodex completed turn ${event.turnId} with empty text]`,
    });
    await this.ackDeliveryIfPresent(event.eventId);
    this.sessionState.pruneIdleState();
  }

  private async handleError(event: ConversationErrorEvent): Promise<void> {
    if (!event.conversationKey) {
      this.logger.error({ event }, 'core reported an unbound error');
      return;
    }

    if (event.turnId) {
      this.sessionState.markTurnFailed(event.conversationKey, event.turnId);
    }

    const sink = this.resolveSink(event.conversationKey);
    if (!sink) {
      this.sessionState.pruneIdleState();
      return;
    }

    await sink.sendText({
      conversationKey: event.conversationKey,
      kind: 'error',
      text: event.message,
    });
    await this.ackDeliveryIfPresent(event.eventId);
    this.sessionState.pruneIdleState();
  }

  private async handleApproval(event: ApprovalRequestedEvent): Promise<void> {
    const sink = this.resolveSink(event.conversationKey);
    if (!sink) {
      this.logger.warn({ event }, 'approval requested for conversation without sink');
      return;
    }

    await sink.sendText({
      conversationKey: event.conversationKey,
      kind: 'approval',
      text: renderApprovalRequest(event),
    });
    await this.ackDeliveryIfPresent(event.eventId);
    this.sessionState.pruneIdleState();
  }

  private async replayPendingDelivery(delivery: PendingDeliveryRecord): Promise<void> {
    switch (delivery.method) {
      case CoreEvents.completed:
        await this.handleCompleted(parseRecoverablePayload<ConversationCompletedEvent>(delivery));
        return;
      case CoreEvents.error:
        await this.handleError(parseRecoverablePayload<ConversationErrorEvent>(delivery));
        return;
      case CoreEvents.approvalRequested:
        await this.handleApproval(parseRecoverablePayload<ApprovalRequestedEvent>(delivery));
        return;
      default:
        this.logger.warn({ delivery }, 'ignoring unknown recoverable delivery method');
    }
  }

  private async ackDeliveryIfPresent(eventId: string | null | undefined): Promise<void> {
    if (!eventId) {
      return;
    }

    try {
      await this.core.ackDelivery({ eventId });
    } catch (error) {
      this.logger.warn({ eventId, error }, 'failed to acknowledge recoverable delivery');
    }
  }

  private resolveSink(conversationKey: string): OutboundSink | undefined {
    return this.sessionState.resolveSink(conversationKey, {
      host: this.host,
      logger: this.logger,
    });
  }

  private get sinks() {
    return this.sessionState.sinks;
  }

  private get activeTurns() {
    return this.sessionState.activeTurns;
  }

  private get failedTurns() {
    return this.sessionState.failedTurns;
  }

  private get streamState() {
    return this.sessionState.streamState;
  }

  private get lastPrunedAt() {
    return this.sessionState.lastPrunedAt;
  }

  private set lastPrunedAt(value: number) {
    this.sessionState.lastPrunedAt = value;
  }

  private pruneIdleState(): void {
    this.sessionState.pruneIdleState();
  }
}
