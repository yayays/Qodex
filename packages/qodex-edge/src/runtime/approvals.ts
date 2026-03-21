import type {
  ApprovalDecision,
  ApprovalRequestedEvent,
  PendingApprovalRecord,
} from '../protocol.js';
import {
  formatCompactValue,
  formatList,
  isRecord,
  safeParseJson,
} from './utils.js';

export function renderApprovalRequest(event: ApprovalRequestedEvent): string {
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

export function renderPendingApprovalSummary(approval: PendingApprovalRecord): string[] {
  const payload = safeParseJson(approval.payloadJson);
  return [
    `${shortApprovalId(approval.approvalId)} (${approval.kind})`,
    ...summarizeApprovalPayload(approval.kind, 'pending approval', payload),
    approval.reason ? `reason=${approval.reason}` : undefined,
    `createdAt=${approval.createdAt}`,
  ].filter(Boolean) as string[];
}

export function renderApprovalUsage(pendingApprovals: PendingApprovalRecord[]): string {
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

export function resolveApprovalId(
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

  const byShortId = pendingApprovals.find(
    (approval) => shortApprovalId(approval.approvalId) === normalized,
  );
  return byShortId?.approvalId;
}

export function parseApprovalIntent(text: string): {
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

function shortApprovalId(approvalId: string): string {
  return approvalId.length > 12 ? approvalId.slice(0, 12) : approvalId;
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
      const lines = [
        files.length > 0 ? `files=${formatList(files, 5)}` : 'files=not provided by backend',
      ];
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
