import type { QodexConfig } from '../config.js';

export interface ConversationProcessingState {
  isProcessing: boolean;
  activeTurns: number;
  latestTurnId?: string;
  latestTurnHasOutput: boolean;
  latestActivityAt?: number;
  startedAt?: number;
}

export interface RuntimeChannelHealth {
  instanceId: string;
  channelId: string;
  accountId?: string;
  status: Record<string, unknown>;
}

export type RuntimeBackendKind = QodexConfig['backend']['kind'];
