import type { ConversationRef, PendingDeliveryRecord } from '../protocol.js';

export function parseRecoverablePayload<T>(delivery: PendingDeliveryRecord): T {
  try {
    return JSON.parse(delivery.payloadJson) as T;
  } catch (error) {
    throw new Error(
      `invalid recoverable delivery payload for ${delivery.eventId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseConversationKey(conversationKey: string): ConversationRef | undefined {
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

export function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function flattenText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncateForLine(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatCompactValue(value: unknown): string {
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

export function formatList(items: string[], limit: number): string {
  if (items.length <= limit) {
    return items.join(', ');
  }
  return `${items.slice(0, limit).join(', ')} (+${items.length - limit} more)`;
}

export function resolveQuickReply(text: string): string | undefined {
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

export function isFailedTurnStatus(status: string): boolean {
  return /failed|error|cancel/i.test(status);
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
