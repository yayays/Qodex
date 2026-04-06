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
import { OutboundSink, PlatformMessage } from './platform-protocol.js';
import { resolveRuntimeApproval } from './runtime/commands.js';
import type { RuntimeChannelHealth } from './runtime/types.js';
import { isFailedTurnStatus } from './runtime/utils.js';
import { RuntimeSessionState } from './runtime/state.js';
import { RuntimeEventPresenter } from './runtime/presenter.js';
import { RuntimeDeliveryReplay } from './runtime/replay.js';
import { RuntimeInboundHandler } from './runtime/inbound.js';

export interface RuntimeHostBridge {
  resolveSinkForConversation(conversation: ConversationRef): OutboundSink | undefined;
  listConversationChannels(conversation?: ConversationRef | null): RuntimeChannelHealth[];
  getRestartInfo?(): {
    configPath: string;
    skipAppServer: boolean;
  };
  requestRestart?(conversation?: ConversationRef): Promise<void>;
}

export class QodexEdgeRuntime {
  private static readonly AUTO_CONTINUE_PROMPT =
    'Continue with the next planned step. If there is no next step, explain briefly and stop.';
  private readonly core: CoreClient;
  private readonly logger: QodexLogger;
  private readonly config: QodexConfig;
  private readonly sessionState = new RuntimeSessionState();
  private readonly presenter: RuntimeEventPresenter;
  private readonly replay: RuntimeDeliveryReplay;
  private inbound: RuntimeInboundHandler;
  private host?: RuntimeHostBridge;

  constructor(core: CoreClient, logger: QodexLogger, config: QodexConfig) {
    this.core = core;
    this.logger = logger;
    this.config = config;
    this.presenter = new RuntimeEventPresenter({
      core: this.core,
      logger: this.logger,
      config: this.config,
      sessionState: this.sessionState,
      resolveSink: (conversationKey) => this.resolveSink(conversationKey),
      isFailedTurnStatus,
      requestAutoContinue: (conversationKey) => this.requestAutoContinue(conversationKey),
    });
    this.replay = new RuntimeDeliveryReplay({
      logger: this.logger,
      listPendingDeliveries: () => this.core.listPendingDeliveries(),
      presenter: this.presenter,
    });
    this.inbound = new RuntimeInboundHandler({
      core: this.core,
      logger: this.logger,
      config: this.config,
      host: this.host,
      sessionState: this.sessionState,
      resolveBackendKind: (message) => this.resolveBackendKind(message),
      resolveApproval: (conversationKey, approvalToken, decision, sink) =>
        this.resolveApproval(conversationKey, approvalToken, decision, sink),
    });
  }

  attachHost(host: RuntimeHostBridge): void {
    this.host = host;
    this.inbound = new RuntimeInboundHandler({
      core: this.core,
      logger: this.logger,
      config: this.config,
      host: this.host,
      sessionState: this.sessionState,
      resolveBackendKind: (message) => this.resolveBackendKind(message),
      resolveApproval: (conversationKey, approvalToken, decision, sink) =>
        this.resolveApproval(conversationKey, approvalToken, decision, sink),
    });
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
    await this.replay.recoverPendingDeliveries();
  }

  async handleIncoming(message: PlatformMessage, sink: OutboundSink): Promise<void> {
    await this.inbound.handleIncoming(message, sink);
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
    await this.presenter.handleDelta(event);
  }

  private async handleCompleted(event: ConversationCompletedEvent): Promise<void> {
    await this.presenter.handleCompleted(event);
  }

  private async handleError(event: ConversationErrorEvent): Promise<void> {
    await this.presenter.handleError(event);
  }

  private async handleApproval(event: ApprovalRequestedEvent): Promise<void> {
    await this.presenter.handleApproval(event);
  }

  private async requestAutoContinue(
    conversationKey: string,
  ): Promise<
    | { status: 'triggered'; stepsUsed: number; maxSteps: number }
    | { status: 'disabled' }
    | { status: 'missingContext' }
    | { status: 'limitReached'; stepsUsed: number; maxSteps: number }
  > {
    const state = this.sessionState.getAutoContinueState(conversationKey);
    if (!state.enabled) {
      return { status: 'disabled' };
    }

    const context = this.sessionState.getAutoContinueContext(conversationKey);
    if (!context) {
      return { status: 'missingContext' };
    }

    if (state.stepsUsed >= state.maxSteps) {
      return {
        status: 'limitReached',
        stepsUsed: state.stepsUsed,
        maxSteps: state.maxSteps,
      };
    }

    const response = await this.core.sendMessage({
      conversation: context.conversation,
      sender: context.sender,
      text: QodexEdgeRuntime.AUTO_CONTINUE_PROMPT,
      workspace: context.workspace,
      backendKind: context.backendKind,
      model: context.model,
      modelProvider: context.modelProvider,
    });
    const next = this.sessionState.incrementAutoContinue(conversationKey);
    this.sessionState.registerActiveTurn(conversationKey, response.turnId);
    return {
      status: 'triggered',
      stepsUsed: next.stepsUsed,
      maxSteps: next.maxSteps,
    };
  }

  private async replayPendingDelivery(delivery: PendingDeliveryRecord): Promise<void> {
    await this.replay.replayPendingDelivery(delivery);
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
