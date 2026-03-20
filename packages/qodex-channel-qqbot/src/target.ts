export type QQBotTargetScope = 'c2c' | 'group' | 'channel';

const TARGET_RE = /^(?:(?<channel>qqbot):)?(?<scope>c2c|group|channel):(?<id>.+)$/i;
const OPENID_RE = /^[a-f0-9]{32}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface QQBotTarget {
  channelId: 'qqbot';
  scope: QQBotTargetScope;
  id: string;
  raw: string;
}

export function normalizeQQBotTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) {
    return target;
  }

  const explicit = parseQQBotTarget(trimmed);
  if (explicit) {
    return formatQQBotTarget(explicit.scope, explicit.id);
  }

  if (looksLikeQQOpenId(trimmed)) {
    return formatQQBotTarget('c2c', trimmed);
  }

  return trimmed;
}

export function parseQQBotTarget(target: string): QQBotTarget | undefined {
  const match = TARGET_RE.exec(target.trim());
  if (!match?.groups) {
    return undefined;
  }

  const scope = match.groups.scope.toLowerCase() as QQBotTargetScope;
  const id = match.groups.id.trim();
  if (!id) {
    return undefined;
  }

  return {
    channelId: 'qqbot',
    scope,
    id,
    raw: target,
  };
}

export function looksLikeQQBotTarget(value: string): boolean {
  return Boolean(parseQQBotTarget(value) ?? looksLikeQQOpenId(value));
}

export function formatQQBotTarget(scope: QQBotTargetScope, id: string): string {
  return `qqbot:${scope}:${id}`;
}

export function looksLikeQQOpenId(value: string): boolean {
  return OPENID_RE.test(value.trim()) || UUID_RE.test(value.trim());
}

export function chunkQQText(text: string, maxLength = 5000): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}
