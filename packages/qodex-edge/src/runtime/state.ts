import type { ConversationRef, OutboundSink } from '../protocol.js';
import type { QodexLogger } from '../logger.js';
import type { ConversationProcessingState } from './types.js';
import { parseConversationKey } from './utils.js';

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

type AutoApproveOverride = boolean;

export interface SinkResolver {
  resolveSinkForConversation(conversation: ConversationRef): OutboundSink | undefined;
}

export class RuntimeSessionState {
  readonly sinks = new Map<string, SinkState>();
  readonly streamState = new Map<string, StreamState>();
  readonly activeTurns = new Map<string, ActiveTurnState>();
  readonly failedTurns = new Map<string, number>();
  readonly autoApprovePermissions = new Map<string, AutoApproveOverride>();
  lastPrunedAt = 0;

  rememberSink(conversationKey: string, sink: OutboundSink): void {
    this.sinks.set(conversationKey, {
      sink,
      lastActivityAt: Date.now(),
    });
  }

  resolveSink(
    conversationKey: string,
    options: {
      host?: SinkResolver;
      logger: QodexLogger;
    },
  ): OutboundSink | undefined {
    const existing = this.getSink(conversationKey);
    if (existing) {
      return existing;
    }

    const conversation = parseConversationKey(conversationKey);
    if (!conversation || !options.host) {
      return undefined;
    }

    try {
      const recovered = options.host.resolveSinkForConversation(conversation);
      if (recovered) {
        this.rememberSink(conversationKey, recovered);
      }
      return recovered;
    } catch (error) {
      options.logger.warn({ conversationKey, error }, 'failed to rebuild outbound sink');
      return undefined;
    }
  }

  appendDelta(conversationKey: string, turnId: string, delta: string): StreamState {
    this.markTurnOutput(conversationKey, turnId);
    const key = `${conversationKey}:${turnId}`;
    const now = Date.now();
    const current = this.streamState.get(key) ?? {
      conversationKey,
      text: '',
      lastFlushAt: 0,
      lastActivityAt: now,
    };
    current.text += delta;
    current.lastActivityAt = now;
    this.streamState.set(key, current);
    return current;
  }

  markStreamFlushed(conversationKey: string, turnId: string, flushedAt = Date.now()): void {
    const current = this.streamState.get(`${conversationKey}:${turnId}`);
    if (current) {
      current.lastFlushAt = flushedAt;
    }
  }

  clearTurn(conversationKey: string, turnId: string): boolean {
    const turnKey = `${conversationKey}:${turnId}`;
    this.streamState.delete(turnKey);
    this.activeTurns.delete(turnKey);
    return this.failedTurns.delete(turnKey);
  }

  markTurnFailed(conversationKey: string, turnId: string): void {
    const turnKey = `${conversationKey}:${turnId}`;
    this.failedTurns.set(turnKey, Date.now());
    this.activeTurns.delete(turnKey);
    this.streamState.delete(turnKey);
  }

  clearConversationTurns(conversationKey: string): void {
    for (const turnKey of this.activeTurns.keys()) {
      if (turnKey.startsWith(`${conversationKey}:`)) {
        this.activeTurns.delete(turnKey);
        this.streamState.delete(turnKey);
        this.failedTurns.delete(turnKey);
      }
    }
  }

  setAutoApprovePermissions(conversationKey: string, enabled: boolean): void {
    this.autoApprovePermissions.set(conversationKey, enabled);
  }

  isAutoApprovePermissionsEnabled(
    conversationKey: string,
    defaultEnabled: boolean,
  ): boolean {
    return this.autoApprovePermissions.get(conversationKey) ?? defaultEnabled;
  }

  registerActiveTurn(conversationKey: string, turnId: string): void {
    const now = Date.now();
    this.activeTurns.set(`${conversationKey}:${turnId}`, {
      conversationKey,
      turnId,
      startedAt: now,
      lastActivityAt: now,
      hasOutput: false,
    });
  }

  getProcessingState(conversationKey: string): ConversationProcessingState {
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

  pruneIdleState(): void {
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

    for (const conversationKey of this.autoApprovePermissions.keys()) {
      if (!activeConversations.has(conversationKey) && !this.sinks.has(conversationKey)) {
        this.autoApprovePermissions.delete(conversationKey);
      }
    }
  }

  private getSink(conversationKey: string): OutboundSink | undefined {
    const state = this.sinks.get(conversationKey);
    if (!state) {
      return undefined;
    }

    state.lastActivityAt = Date.now();
    return state.sink;
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
}
