import pino from 'pino';

export function createLogger(level = process.env.LOG_LEVEL ?? 'info') {
  return pino({
    name: 'qodex-edge',
    level,
    base: undefined,
  });
}

export type QodexLogger = ReturnType<typeof createLogger>;
