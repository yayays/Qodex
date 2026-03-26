import { Writable } from 'node:stream';
import pino from 'pino';

export type LogFormat = 'pretty' | 'json';

interface CreateLoggerOptions {
  format?: LogFormat;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  destination?: NodeJS.WritableStream;
}

const RESERVED_LOG_KEYS = new Set(['level', 'time', 'msg', 'name']);

export function createLogger(
  level = process.env.LOG_LEVEL ?? 'info',
  options: CreateLoggerOptions = {},
) {
  const format = options.format ?? resolveLogFormat({
    env: options.env,
    isTTY: options.isTTY,
  });
  const destination = options.destination ?? process.stdout;
  return pino(
    {
      name: 'qodex-edge',
      level,
      base: undefined,
    },
    format === 'pretty' ? createPrettyDestination(destination) : destination,
  );
}

export function resolveLogFormat(params: {
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
}): LogFormat {
  const env = params.env ?? process.env;
  const forced = env.QODEX_LOG_FORMAT?.trim().toLowerCase();
  if (forced === 'pretty') {
    return 'pretty';
  }
  if (forced === 'json') {
    return 'json';
  }

  const isTTY = params.isTTY ?? Boolean(process.stdout.isTTY);
  if (!isTTY || isTruthyEnv(env.CI)) {
    return 'json';
  }
  return 'pretty';
}

export function formatPrettyLogLine(record: Record<string, unknown>): string {
  const level = formatLevel(record.level);
  const timestamp = formatTimestamp(record.time);
  const name = typeof record.name === 'string' ? record.name : 'qodex-edge';
  const scope = formatScope(record);
  const message = typeof record.msg === 'string' ? record.msg : '(no message)';
  const extras = Object.entries(record).filter(([key]) => !RESERVED_LOG_KEYS.has(key));
  const lines = [`${timestamp} ${level} ${name}${scope} ${message}`];

  for (const [key, value] of extras) {
    lines.push(...formatPrettyField(key, value, 1));
  }

  return `${lines.join('\n')}\n`;
}

function createPrettyDestination(destination: NodeJS.WritableStream): Writable {
  let pending = '';
  return new Writable({
    write(chunk, _encoding, callback) {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        destination.write(formatPrettyChunk(line));
      }
      callback();
    },
    final(callback) {
      if (pending.trim()) {
        destination.write(formatPrettyChunk(pending));
      }
      callback();
    },
  });
}

function formatPrettyChunk(line: string): string {
  try {
    return formatPrettyLogLine(JSON.parse(line) as Record<string, unknown>);
  } catch {
    return `${line}\n`;
  }
}

function formatPrettyField(
  key: string,
  value: unknown,
  depth: number,
): string[] {
  const indent = '  '.repeat(depth);
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${indent}${key}: []`];
    }
    const lines = [`${indent}${key}:`];
    for (const entry of value) {
      if (isPlainObject(entry)) {
        lines.push(`${indent}  -`);
        lines.push(...formatPrettyObject(entry, depth + 2));
      } else {
        lines.push(`${indent}  - ${formatPrettyScalar(key, entry)}`);
      }
    }
    return lines;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, nested]) => nested !== undefined);
    if (entries.length === 0) {
      return [`${indent}${key}: {}`];
    }
    return [
      `${indent}${key}:`,
      ...formatPrettyObject(value, depth + 1),
    ];
  }
  return [`${indent}${key}: ${formatPrettyScalar(key, value)}`];
}

function formatPrettyObject(
  value: Record<string, unknown>,
  depth: number,
): string[] {
  return Object.entries(value).flatMap(([key, nested]) =>
    formatPrettyField(key, nested, depth),
  );
}

function formatPrettyScalar(key: string, value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (looksLikeTimestampField(key, value)) {
      return `${new Date(value).toISOString()} (${value})`;
    }
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value === null) {
    return 'null';
  }
  return JSON.stringify(value);
}

function formatLevel(value: unknown): string {
  switch (value) {
    case 10:
      return 'TRACE';
    case 20:
      return 'DEBUG';
    case 30:
      return 'INFO ';
    case 40:
      return 'WARN ';
    case 50:
      return 'ERROR';
    case 60:
      return 'FATAL';
    default:
      return 'INFO ';
  }
}

function formatTimestamp(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function formatScope(record: Record<string, unknown>): string {
  const segments = [record.channelId, record.instanceId, record.accountId]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return segments.length > 0 ? ` [${segments.join(' ')}]` : '';
}

function looksLikeTimestampField(key: string, value: number): boolean {
  return value > 1_000_000_000_000 && /(?:At|Time|time)$/i.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

export type QodexLogger = ReturnType<typeof createLogger>;
