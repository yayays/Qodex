import type {
  ApprovalRequestedEvent,
  ConversationDetailsResponse,
  ConversationRunningResponse,
  PendingApprovalRecord,
} from '../protocol.js';
import type { RuntimeBackendKind, ConversationProcessingState, RuntimeChannelHealth } from './types.js';
import { renderPendingApprovalSummary } from './approvals.js';
import { flattenText, truncateForLine } from './utils.js';

export function renderStatus(
  title: string,
  status: {
    conversation?: { workspace: string; threadId?: string | null } | null;
    pendingApprovals: { approvalId: string; kind: string }[];
  },
  defaultWorkspace: string,
  processing: ConversationProcessingState,
  backendKind: RuntimeBackendKind,
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

export function renderRunningState(
  state: ConversationProcessingState,
  running: ConversationRunningResponse,
  backendKind: RuntimeBackendKind,
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

export function renderDetailedStatus(
  details: ConversationDetailsResponse,
  processing: ConversationProcessingState,
  defaultWorkspace: string,
  channelHealth: RuntimeChannelHealth[],
  backendKind: RuntimeBackendKind,
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

export function renderHelp(
  defaultWorkspace: string,
  backendKind: RuntimeBackendKind,
): string {
  return [
    'Qodex commands',
    '/help',
    '/bind /absolute/workspace/path',
    '/new',
    '/status',
    '/status+',
    '/running',
    '/memory',
    '/remember <bot|workspace|user> <category> <content>',
    '/forget <memoryId>',
    '/profile [bot|workspace|user] [path=value|path+=value|path-=value|!path ...]',
    '/summary [text|clear]',
    '/hint <bot|workspace|user> <text>',
    '/unhint <hintId>',
    '/approve <approvalId> [session]',
    '/reject <approvalId>',
    `backend=${backendKind}`,
    `defaultWorkspace=${defaultWorkspace}`,
  ].join('\n');
}

function describeRunningHeadline(
  state: ConversationProcessingState,
  backendStatus: string | undefined,
  backendKind: RuntimeBackendKind,
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
