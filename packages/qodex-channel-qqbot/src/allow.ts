import type { QQBotTargetScope } from './target.js';

export function isQQBotSenderAllowed(
  allowFrom: string[],
  scope: QQBotTargetScope,
  targetId: string,
  senderId: string,
): boolean {
  if (allowFrom.length === 0) {
    return true;
  }

  const candidates = buildAllowCandidates(scope, targetId, senderId);
  return allowFrom.some((rule) => rule === '*' || candidates.has(normalizeRule(rule)));
}

function buildAllowCandidates(
  scope: QQBotTargetScope,
  targetId: string,
  senderId: string,
): Set<string> {
  const normalizedScope = scope.trim().toLowerCase() as QQBotTargetScope;
  const normalizedTarget = targetId.trim();
  const normalizedSender = senderId.trim();

  return new Set(
    [
      normalizedSender,
      normalizedTarget,
      `${normalizedScope}:${normalizedSender}`,
      `${normalizedScope}:${normalizedTarget}`,
      `${normalizedScope}:${normalizedTarget}:${normalizedSender}`,
      `qqbot:${normalizedScope}:${normalizedSender}`,
      `qqbot:${normalizedScope}:${normalizedTarget}`,
      `qqbot:${normalizedScope}:${normalizedTarget}:${normalizedSender}`,
    ].map(normalizeRule),
  );
}

function normalizeRule(value: string): string {
  return value.trim().toLowerCase();
}
