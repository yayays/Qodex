import { CoreClient } from './coreClient.js';
import { QodexConfig } from './config.js';
import { QodexLogger } from './logger.js';
import {
  ApprovalDecision,
  ApprovalRequestedEvent,
  ConversationCompletedEvent,
  ConversationDetailsResponse,
  ConversationDeltaEvent,
  ConversationErrorEvent,
  ConversationRef,
  ConversationRunningResponse,
  CoreEvents,
  OutboundSink,
  PendingApprovalRecord,
  PendingDeliveryRecord,
  PlatformMessage,
  StreamUpdateMessage,
} from './protocol.js';

const RUNTIME_PRUNE_INTERVAL_MS = 60_000;
const RUNTIME_IDLE_TTL_MS = 60 * 60_000;

interface StreamState {
  conversationKey: string;
  text: string;
  lastFlushAt: number;
  lastActivityAt: number;
}

interface SinkState {
  sink: OutboundSink;
  lastActivityAt: number;
}

interface ActiveTurnState {
  conversationKey: string;
  turnId: string;
  startedAt: number;
  lastActivityAt: number;
  hasOutput: boolean;
}

export interface RuntimeChannelHealth {
  instanceId: string;
  channelId: string;
  accountId?: string;
  status: Record<string, unknown>;
}

export interface RuntimeHostBridge {
  resolveSinkForConversation(conversation: ConversationRef): OutboundSink | undefined;
  listConversationChannels(conversation?: ConversationRef | null): RuntimeChannelHealth[];
}

export class QodexEdgeRuntime {
  private readonly core: CoreClient;
  private readonly logger: QodexLogger;
  private readonly config: QodexConfig;
  private readonly sinks = new Map<string, SinkState>();
  private readonly streamState = new Map<string, StreamState>();
  private readonly activeTurns = new Map<string, ActiveTurnState>();
  private readonly failedTurns = new Map<string, number>();
  private lastPrunedAt = 0;
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
    this.rememberSink(message.conversation.conversationKey, sink);
    this.pruneIdleState();
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
      this.registerActiveTurn(message.conversation.conversationKey, response.turnId);

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
    const [command, ...rest] = message.text.trim().split(/\s+/);
    const argumentText = message.text.trim().slice(command.length).trim();
    const conversationKey = message.conversation.conversationKey;
    const messageBackendKind = this.resolveBackendKind(message);

    switch (command) {
      case '/help': {
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: renderHelp(this.config.backend.defaultWorkspace, messageBackendKind),
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
        const status = await this.core.bindWorkspace({
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
            this.config.backend.defaultWorkspace,
            this.getConversationProcessingState(conversationKey),
            status.conversation?.backendKind ?? messageBackendKind,
          ),
        });
        return;
      }
      case '/new': {
        const status = await this.core.newThread({
          conversationKey,
          backendKind: messageBackendKind,
        });
        this.clearConversationTurns(conversationKey);
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: renderStatus(
            'Thread reset',
            status,
            this.config.backend.defaultWorkspace,
            this.getConversationProcessingState(conversationKey),
            status.conversation?.backendKind ?? messageBackendKind,
          ),
        });
        return;
      }
      case '/status': {
        const status = await this.core.status({ conversationKey });
        const processing = this.getConversationProcessingState(conversationKey);
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: renderStatus(
            'Current state',
            status,
            this.config.backend.defaultWorkspace,
            processing,
            status.conversation?.backendKind ?? messageBackendKind,
          ),
        });
        return;
      }
      case '/status+': {
        const details = await this.core.details({
          conversationKey,
          messageLimit: 6,
        });
        const processing = this.getConversationProcessingState(conversationKey);
        const conversation = details.conversation ?? parseConversationKey(conversationKey);
        const channelHealth = this.host?.listConversationChannels(conversation ?? null) ?? [];
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: renderDetailedStatus(
            details,
            processing,
            this.config.backend.defaultWorkspace,
            channelHealth,
            details.conversation?.backendKind ?? messageBackendKind,
          ),
        });
        return;
      }
      case '/running': {
        const running = await this.core.running({ conversationKey });
        const processing = this.getConversationProcessingState(conversationKey);
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
        await this.resolveApproval(conversationKey, approvalId, decision, sink);
        return;
      }
      case '/reject': {
        const approvalId = rest[0];
        await this.resolveApproval(conversationKey, approvalId, 'decline', sink);
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

  private resolveBackendKind(message: PlatformMessage): QodexConfig['backend']['kind'] {
    return message.backendKind ?? this.config.backend.kind;
  }

  private async resolveApproval(
    conversationKey: string,
    approvalToken: string | undefined,
    decision: ApprovalDecision,
    sink: OutboundSink,
  ): Promise<void> {
    const status = await this.core.status({ conversationKey });
    const approvalId = resolveApprovalId(status.pendingApprovals, approvalToken);
    if (!approvalId) {
      await sink.sendText({
        conversationKey,
        kind: 'error',
        text: renderApprovalUsage(status.pendingApprovals),
      });
      return;
    }

    const response = await this.core.respondApproval({ approvalId, decision });
    await sink.sendText({
      conversationKey,
      kind: 'system',
      text: `Approval ${response.approvalId} -> ${response.status}`,
    });
  }

  private async handleDelta(event: ConversationDeltaEvent): Promise<void> {
    this.markTurnOutput(event.conversationKey, event.turnId);
    const sink = this.resolveSink(event.conversationKey);
    if (!sink?.sendStreamUpdate) {
      return;
    }

    const key = `${event.conversationKey}:${event.turnId}`;
    const now = Date.now();
    const current = this.streamState.get(key) ?? {
      conversationKey: event.conversationKey,
      text: '',
      lastFlushAt: 0,
      lastActivityAt: now,
    };
    current.text += event.delta;
    current.lastActivityAt = now;

    if (now - current.lastFlushAt >= this.config.edge.streamFlushMs) {
      const payload: StreamUpdateMessage = {
        conversationKey: event.conversationKey,
        kind: 'stream',
        turnId: event.turnId,
        text: current.text,
      };
      await sink.sendStreamUpdate(payload);
      current.lastFlushAt = now;
    }

    this.streamState.set(key, current);
    this.pruneIdleState();
  }

  private async handleCompleted(event: ConversationCompletedEvent): Promise<void> {
    const turnKey = `${event.conversationKey}:${event.turnId}`;
    this.streamState.delete(turnKey);
    this.activeTurns.delete(turnKey);
    const failed = this.failedTurns.delete(turnKey) || isFailedTurnStatus(event.status);
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
      this.pruneIdleState();
      return;
    }

    const sink = this.resolveSink(event.conversationKey);
    if (!sink) {
      this.pruneIdleState();
      return;
    }

    await sink.sendText({
      conversationKey: event.conversationKey,
      kind: 'final',
      text: event.text || `[Qodex completed turn ${event.turnId} with empty text]`,
    });
    await this.ackDeliveryIfPresent(event.eventId);
    this.pruneIdleState();
  }

  private async handleError(event: ConversationErrorEvent): Promise<void> {
    if (!event.conversationKey) {
      this.logger.error({ event }, 'core reported an unbound error');
      return;
    }

    if (event.turnId) {
      const turnKey = `${event.conversationKey}:${event.turnId}`;
      this.failedTurns.set(turnKey, Date.now());
      this.activeTurns.delete(turnKey);
      this.streamState.delete(turnKey);
    }

    const sink = this.resolveSink(event.conversationKey);
    if (!sink) {
      this.pruneIdleState();
      return;
    }

    await sink.sendText({
      conversationKey: event.conversationKey,
      kind: 'error',
      text: event.message,
    });
    await this.ackDeliveryIfPresent(event.eventId);
    this.pruneIdleState();
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
    this.pruneIdleState();
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

  private rememberSink(conversationKey: string, sink: OutboundSink): void {
    this.sinks.set(conversationKey, {
      sink,
      lastActivityAt: Date.now(),
    });
  }

  private getSink(conversationKey: string): OutboundSink | undefined {
    const state = this.sinks.get(conversationKey);
    if (!state) {
      return undefined;
    }

    state.lastActivityAt = Date.now();
    return state.sink;
  }

  private resolveSink(conversationKey: string): OutboundSink | undefined {
    const existing = this.getSink(conversationKey);
    if (existing) {
      return existing;
    }

    const conversation = parseConversationKey(conversationKey);
    if (!conversation || !this.host) {
      return undefined;
    }

    try {
      const recovered = this.host.resolveSinkForConversation(conversation);
      if (recovered) {
        this.rememberSink(conversationKey, recovered);
      }
      return recovered;
    } catch (error) {
      this.logger.warn({ conversationKey, error }, 'failed to rebuild outbound sink');
      return undefined;
    }
  }

  private clearConversationTurns(conversationKey: string): void {
    for (const turnKey of this.activeTurns.keys()) {
      if (turnKey.startsWith(`${conversationKey}:`)) {
        this.activeTurns.delete(turnKey);
        this.streamState.delete(turnKey);
        this.failedTurns.delete(turnKey);
      }
    }
  }

  private registerActiveTurn(conversationKey: string, turnId: string): void {
    const now = Date.now();
    this.activeTurns.set(`${conversationKey}:${turnId}`, {
      conversationKey,
      turnId,
      startedAt: now,
      lastActivityAt: now,
      hasOutput: false,
    });
  }

  private markTurnOutput(conversationKey: string, turnId: string): void {
    const key = `${conversationKey}:${turnId}`;
    const current = this.activeTurns.get(key);
    if (current) {
      current.lastActivityAt = Date.now();
      current.hasOutput = true;
      return;
    }

    const now = Date.now();
    this.activeTurns.set(key, {
      conversationKey,
      turnId,
      startedAt: now,
      lastActivityAt: now,
      hasOutput: true,
    });
  }

  private getConversationProcessingState(
    conversationKey: string,
  ): ConversationProcessingState {
    let activeTurns = 0;
    let latestTurnId: string | undefined;
    let latestTurnHasOutput = false;
    let latestActivityAt = 0;
    let startedAt: number | undefined;

    for (const turn of this.activeTurns.values()) {
      if (turn.conversationKey !== conversationKey) {
        continue;
      }
      activeTurns += 1;
      if (turn.lastActivityAt >= latestActivityAt) {
        latestActivityAt = turn.lastActivityAt;
        latestTurnId = turn.turnId;
        latestTurnHasOutput = turn.hasOutput;
        startedAt = turn.startedAt;
      }
    }

    return {
      isProcessing: activeTurns > 0,
      activeTurns,
      latestTurnId,
      latestTurnHasOutput,
      latestActivityAt: latestActivityAt || undefined,
      startedAt,
    };
  }

  private pruneIdleState(): void {
    const now = Date.now();
    if (now - this.lastPrunedAt < RUNTIME_PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPrunedAt = now;

    for (const [turnKey, state] of this.activeTurns) {
      if (now - state.lastActivityAt >= RUNTIME_IDLE_TTL_MS) {
        this.activeTurns.delete(turnKey);
      }
    }

    for (const [turnKey, state] of this.streamState) {
      if (now - state.lastActivityAt >= RUNTIME_IDLE_TTL_MS) {
        this.streamState.delete(turnKey);
      }
    }

    for (const [turnKey, lastFailedAt] of this.failedTurns) {
      if (now - lastFailedAt >= RUNTIME_IDLE_TTL_MS) {
        this.failedTurns.delete(turnKey);
      }
    }

    const activeConversations = new Set(
      [...this.activeTurns.values()].map((state) => state.conversationKey),
    );
    for (const [conversationKey, sink] of this.sinks) {
      if (
        !activeConversations.has(conversationKey)
        && now - sink.lastActivityAt >= RUNTIME_IDLE_TTL_MS
      ) {
        this.sinks.delete(conversationKey);
      }
    }
  }
}

function renderStatus(
  title: string,
  status: {
    conversation?: { workspace: string; threadId?: string | null } | null;
    pendingApprovals: { approvalId: string; kind: string }[];
  },
  defaultWorkspace: string,
  processing: ConversationProcessingState,
  backendKind: QodexConfig['backend']['kind'],
): string {
  const conversation = status.conversation;
  const lines = [title];

  if (!conversation) {
    lines.push('conversation=not-initialized');
    lines.push(`workspace=${defaultWorkspace}`);
    lines.push('thread=none');
  } else {
    lines.push(`workspace=${conversation.workspace}`);
    lines.push(`thread=${conversation.threadId ?? 'none'}`);
  }

  lines.push(`defaultWorkspace=${defaultWorkspace}`);
  lines.push(`backend=${backendKind}`);

  if (status.pendingApprovals.length === 0) {
    lines.push('pendingApprovals=0');
  } else {
    lines.push(
      `pendingApprovals=${status.pendingApprovals
        .map((approval) => `${approval.approvalId}:${approval.kind}`)
        .join(', ')}`,
    );
  }
  lines.push(`processing=${processing.isProcessing ? 'active' : 'idle'}`);
  lines.push(`activeTurns=${processing.activeTurns}`);
  if (processing.latestTurnId) {
    lines.push(`activeTurn=${processing.latestTurnId}`);
    lines.push(
      `output=${processing.latestTurnHasOutput ? 'streaming' : 'waiting-first-output'}`,
    );
  }

  return lines.join('\n');
}

interface ConversationProcessingState {
  isProcessing: boolean;
  activeTurns: number;
  latestTurnId?: string;
  latestTurnHasOutput: boolean;
  latestActivityAt?: number;
  startedAt?: number;
}

function renderRunningState(
  state: ConversationProcessingState,
  running: ConversationRunningResponse,
  backendKind: QodexConfig['backend']['kind'],
): string {
  const backend = running.runtime;
  const threadId = backend?.threadId ?? running.conversation?.threadId;
  const lines = [describeRunningHeadline(state, backend?.status, backendKind)];

  lines.push(`backendThread=${threadId ?? 'none'}`);
  lines.push(`backendStatus=${backend?.status ?? (threadId ? 'unknown' : 'uninitialized')}`);
  if (backend?.activeFlags.length) {
    lines.push(`backendFlags=${backend.activeFlags.join(',')}`);
  }
  if (backend?.error) {
    lines.push(`backendError=${backend.error}`);
  }

  lines.push(`localProcessing=${state.isProcessing ? 'active' : 'idle'}`);
  lines.push(`activeTurns=${state.activeTurns}`);
  if (state.latestTurnId) {
    lines.push(`activeTurn=${state.latestTurnId}`);
    lines.push(
      `output=${state.latestTurnHasOutput ? 'streaming' : 'waiting-first-output'}`,
    );
  }
  if (state.startedAt) {
    lines.push(`startedAt=${new Date(state.startedAt).toISOString()}`);
  }
  if (state.latestActivityAt) {
    lines.push(`lastActivityAt=${new Date(state.latestActivityAt).toISOString()}`);
  }
  return lines.join('\n');
}

function renderDetailedStatus(
  details: ConversationDetailsResponse,
  processing: ConversationProcessingState,
  defaultWorkspace: string,
  channelHealth: RuntimeChannelHealth[],
  backendKind: QodexConfig['backend']['kind'],
): string {
  const lines = [
    renderStatus('Current state+', details, defaultWorkspace, processing, backendKind),
  ];
  const runtime = details.runtime;

  if (runtime) {
    lines.push(`backendThread=${runtime.threadId}`);
    lines.push(`backendStatus=${runtime.status}`);
    if (runtime.activeFlags.length > 0) {
      lines.push(`backendFlags=${runtime.activeFlags.join(',')}`);
    }
    if (runtime.error) {
      lines.push(`backendError=${runtime.error}`);
    }
  }

  if (details.recentTurn) {
    lines.push(
      `recentTurn=${details.recentTurn.turnId} status=${details.recentTurn.status} at=${details.recentTurn.createdAt}`,
    );
  }
  if (details.recentError) {
    lines.push(`recentError=${details.recentError.message}`);
    lines.push(`recentErrorAt=${details.recentError.createdAt}`);
  }

  if (channelHealth.length === 0) {
    lines.push('channelHealth=unmatched');
  } else {
    lines.push(
      `channelHealth=${channelHealth
        .map((channel) => {
          const connected = typeof channel.status.connected === 'boolean'
            ? String(channel.status.connected)
            : 'unknown';
          const lastError =
            typeof channel.status.lastError === 'string' ? channel.status.lastError : 'none';
          return `${channel.instanceId}:${channel.channelId}:connected=${connected}:lastError=${lastError}`;
        })
        .join(', ')}`,
    );
  }

  if (details.recentMessages.length === 0) {
    lines.push('recentMessages=0');
  } else {
    lines.push('recentMessages:');
    for (const message of details.recentMessages) {
      lines.push(
        `- [${message.role}] ${message.createdAt} ${truncateForLine(flattenText(message.content), 160)}`,
      );
    }
  }

  if (details.pendingApprovals.length > 0) {
    lines.push('approvalDetails:');
    for (const approval of details.pendingApprovals) {
      lines.push(...renderPendingApprovalSummary(approval).map((line) => `- ${line}`));
    }
  }

  return lines.join('\n');
}

function describeRunningHeadline(
  state: ConversationProcessingState,
  backendStatus: string | undefined,
  backendKind: QodexConfig['backend']['kind'],
): string {
  const backendLabel = backendKind === 'opencode' ? 'OpenCode backend' : 'Codex backend';
  switch (backendStatus) {
    case 'active':
      return `Qodex runtime is healthy and the ${backendLabel} reports this conversation is active.`;
    case 'idle':
      return `Qodex runtime is healthy and the ${backendLabel} reports this conversation is idle.`;
    case 'systemError':
      return `Qodex reached core, but the ${backendLabel} reports a system error for this thread.`;
    case 'missing':
      return `Qodex reached core, but the stored ${backendLabel} thread no longer exists.`;
    case 'unavailable':
      return `Qodex reached core, but could not confirm the ${backendLabel} thread status.`;
    default:
      return state.isProcessing
        ? 'Qodex runtime is healthy and processing this conversation.'
        : 'Qodex runtime is healthy and idle for this conversation.';
  }
}

function renderHelp(
  defaultWorkspace: string,
  backendKind: QodexConfig['backend']['kind'],
): string {
  return [
    'Qodex commands',
    '/help',
    '/bind /absolute/workspace/path',
    '/new',
    '/status',
    '/status+',
    '/running',
    '/approve <approvalId> [session]',
    '/reject <approvalId>',
    `backend=${backendKind}`,
    `defaultWorkspace=${defaultWorkspace}`,
  ].join('\n');
}

function renderApprovalRequest(event: ApprovalRequestedEvent): string {
  const payload = safeParseJson(event.payloadJson);
  const detailLines = summarizeApprovalPayload(event.kind, event.summary, payload);
  const decisions = resolveApprovalDecisions(event.availableDecisions, payload);
  const token = shortApprovalId(event.approvalId);
  return [
    `需要确认：${token}`,
    `kind=${event.kind}`,
    ...detailLines,
    event.reason ? `reason=${event.reason}` : undefined,
    `decisions=${decisions.join(', ')}`,
    `回复“同意”或“拒绝”即可`,
    `如有多个待确认，可回复“同意 1”/“拒绝 2”/“同意 ${token}”`,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderPendingApprovalSummary(approval: PendingApprovalRecord): string[] {
  const payload = safeParseJson(approval.payloadJson);
  return [
    `${shortApprovalId(approval.approvalId)} (${approval.kind})`,
    ...summarizeApprovalPayload(approval.kind, 'pending approval', payload),
    approval.reason ? `reason=${approval.reason}` : undefined,
    `createdAt=${approval.createdAt}`,
  ].filter(Boolean) as string[];
}

function renderApprovalUsage(pendingApprovals: PendingApprovalRecord[]): string {
  if (pendingApprovals.length === 0) {
    return '当前会话没有待确认操作。';
  }

  if (pendingApprovals.length === 1) {
    const token = shortApprovalId(pendingApprovals[0].approvalId);
    return `当前有 1 个待确认操作，直接回复“同意”或“拒绝”即可；也可以回复“同意 ${token}”`;
  }

  const tokens = pendingApprovals
    .slice(0, 3)
    .map((approval) => shortApprovalId(approval.approvalId))
    .join(', ');
  return `当前有 ${pendingApprovals.length} 个待确认操作。可回复“同意 1”/“拒绝 2”/“同意 latest”；待确认：${tokens}`;
}

function resolveApprovalId(
  pendingApprovals: PendingApprovalRecord[],
  token: string | undefined,
): string | undefined {
  if (pendingApprovals.length === 0) {
    return undefined;
  }

  if (!token) {
    return pendingApprovals.length === 1 ? pendingApprovals[0].approvalId : undefined;
  }

  const normalized = token.trim();
  if (!normalized) {
    return pendingApprovals.length === 1 ? pendingApprovals[0].approvalId : undefined;
  }

  if (normalized === 'latest') {
    return pendingApprovals[0].approvalId;
  }

  const index = Number(normalized);
  if (Number.isInteger(index) && index >= 1 && index <= pendingApprovals.length) {
    return pendingApprovals[index - 1].approvalId;
  }

  const exact = pendingApprovals.find((approval) => approval.approvalId === normalized);
  if (exact) {
    return exact.approvalId;
  }

  const byShortId = pendingApprovals.find((approval) => shortApprovalId(approval.approvalId) === normalized);
  return byShortId?.approvalId;
}

function shortApprovalId(approvalId: string): string {
  return approvalId.length > 12 ? approvalId.slice(0, 12) : approvalId;
}

function parseApprovalIntent(text: string): {
  decision: ApprovalDecision;
  approvalToken?: string;
} | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  const parts = trimmed.split(/\s+/);
  const head = parts[0].toLowerCase();
  const approvalToken = parts[1];

  if (['同意', '可以', '通过', '批准', '准了', 'ok', 'yes', 'y'].includes(head)) {
    return {
      decision: parts[1]?.toLowerCase() === 'session' ? 'acceptForSession' : 'accept',
      approvalToken,
    };
  }

  if (['拒绝', '不可以', '不行', '否', '取消', 'reject', 'no', 'n'].includes(head)) {
    return {
      decision: head === '取消' ? 'cancel' : 'decline',
      approvalToken,
    };
  }

  return undefined;
}

function summarizeApprovalPayload(
  kind: string,
  fallbackSummary: string,
  payload: unknown,
): string[] {
  const data = isRecord(payload) ? payload : undefined;
  switch (kind) {
    case 'commandExecution': {
      const command = extractCommand(data);
      return [command ? `command=${command}` : `summary=${fallbackSummary}`];
    }
    case 'fileChange': {
      const files = collectFilePaths(data);
      const lines = [files.length > 0
        ? `files=${formatList(files, 5)}`
        : 'files=not provided by backend'];
      const changeCount = Array.isArray(data?.changes) ? data.changes.length : undefined;
      if (changeCount) {
        lines.push(`changeCount=${changeCount}`);
      }
      return lines;
    }
    case 'permissions': {
      const permissions = data?.permissions;
      if (isRecord(permissions)) {
        const entries = Object.entries(permissions).slice(0, 5);
        if (entries.length > 0) {
          return entries.map(([key, value]) => `permission.${key}=${formatCompactValue(value)}`);
        }
      }
      if (permissions !== undefined) {
        return [`permissions=${formatCompactValue(permissions)}`];
      }
      return [`summary=${fallbackSummary}`];
    }
    default:
      return [`summary=${fallbackSummary}`];
  }
}

function resolveApprovalDecisions(
  eventDecisions: string[] | undefined,
  payload: unknown,
): string[] {
  if (eventDecisions && eventDecisions.length > 0) {
    return eventDecisions;
  }

  const raw = isRecord(payload) ? payload.availableDecisions : undefined;
  if (!Array.isArray(raw)) {
    return ['accept', 'acceptForSession', 'decline', 'cancel'];
  }

  const mapped = raw
    .map((value) => {
      if (typeof value === 'string') {
        return value;
      }
      if (isRecord(value) && 'acceptWithExecpolicyAmendment' in value) {
        return 'acceptWithExecpolicyAmendment';
      }
      if (isRecord(value) && 'applyNetworkPolicyAmendment' in value) {
        return 'applyNetworkPolicyAmendment';
      }
      return undefined;
    })
    .filter((value): value is string => Boolean(value));

  return mapped.length > 0 ? mapped : ['accept', 'acceptForSession', 'decline', 'cancel'];
}

function extractCommand(payload: Record<string, unknown> | undefined): string | undefined {
  const command = payload?.command;
  if (typeof command === 'string' && command.trim()) {
    return command.trim();
  }
  if (Array.isArray(command)) {
    const parts = command.filter((value): value is string => typeof value === 'string');
    if (parts.length > 0) {
      return parts.join(' ');
    }
  }
  return undefined;
}

function collectFilePaths(payload: Record<string, unknown> | undefined): string[] {
  const found = new Set<string>();
  collectNestedPaths(payload, found, 0);
  return [...found];
}

function collectNestedPaths(value: unknown, found: Set<string>, depth: number): void {
  if (depth > 3 || value == null) {
    return;
  }

  if (typeof value === 'string') {
    if (looksLikePath(value)) {
      found.add(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedPaths(item, found, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string' && isPathKey(key) && nested.trim()) {
      found.add(nested);
      continue;
    }
    collectNestedPaths(nested, found, depth + 1);
  }
}

function isPathKey(key: string): boolean {
  return ['path', 'file', 'filepath', 'filePath', 'targetFile', 'oldPath', 'newPath'].includes(key);
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || /\.[a-z0-9]+$/i.test(value);
}

function parseRecoverablePayload<T>(delivery: PendingDeliveryRecord): T {
  try {
    return JSON.parse(delivery.payloadJson) as T;
  } catch (error) {
    throw new Error(
      `invalid recoverable delivery payload for ${delivery.eventId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseConversationKey(conversationKey: string): ConversationRef | undefined {
  const [platform, scope, ...rest] = conversationKey.split(':');
  const externalId = rest.join(':');
  if (!platform || !scope || !externalId) {
    return undefined;
  }
  return {
    conversationKey,
    platform,
    scope,
    externalId,
  };
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flattenText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateForLine(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatCompactValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return formatList(value.map((entry) => formatCompactValue(entry)), 4);
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .slice(0, 4)
      .map(([key, nested]) => `${key}:${formatCompactValue(nested)}`)
      .join(', ');
  }
  return String(value);
}

function formatList(items: string[], limit: number): string {
  if (items.length <= limit) {
    return items.join(', ');
  }
  return `${items.slice(0, limit).join(', ')} (+${items.length - limit} more)`;
}

function resolveQuickReply(text: string): string | undefined {
  if (!text || text.length > 24) {
    return undefined;
  }

  if (containsTaskIntent(text)) {
    return undefined;
  }

  const normalized = normalizeQuickReplyText(text);
  switch (normalized) {
    case '你在么':
    case '你在吗':
    case '你在不在':
    case '在么':
    case '在吗':
    case '在不在':
      return '在的，你可以直接说需求。';
    case '你好':
    case 'hello':
    case 'hi':
    case 'hey':
      return '你好，我在。你可以直接告诉我你想做什么。';
    case 'ping':
      return 'pong，我在运行中。';
    default:
      return undefined;
  }
}

function containsTaskIntent(text: string): boolean {
  return [
    '帮我',
    '为什么',
    '怎么',
    '如何',
    '修复',
    '实现',
    '分析',
    '解释',
    '写',
    '改',
    '看下',
    '看看',
    '报错',
  ].some((token) => text.includes(token));
}

function normalizeQuickReplyText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s!?.,'"`~:;(){}\[\]<>@#$%^&*_+=|\\/，。！？；：“”‘’、…-]+/g, '');
}

function isFailedTurnStatus(status: string): boolean {
  return /failed|error|cancel/i.test(status);
}
