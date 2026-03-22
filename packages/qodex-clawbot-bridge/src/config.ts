import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'toml';

import type { ClawbotBridgeConfig } from './types.js';

export async function loadBridgeConfig(configPath = './qodex.toml'): Promise<ClawbotBridgeConfig> {
  const absolute = resolve(configPath);
  const raw = await readFile(absolute, 'utf8');
  const parsed = parse(raw) as Record<string, unknown>;
  const bridge = asRecord(parsed.clawbot_bridge);
  const qodex = asRecord(bridge?.qodex);
  const clawbot = asRecord(bridge?.clawbot);
  const server = asRecord(bridge?.server);

  return {
    server: {
      host: readString(server?.host) ?? '127.0.0.1',
      port: readInteger(server?.port) ?? 7840,
      path: readString(server?.path) ?? '/webhooks/clawbot',
      signatureHeader:
        readString(server?.signature_header)
        ?? readString(server?.signatureHeader),
      signatureToken:
        readString(server?.signature_token)
        ?? readString(server?.signatureToken),
    },
    qodex: {
      coreUrl:
        readString(qodex?.core_url)
        ?? readString(qodex?.coreUrl)
        ?? 'ws://127.0.0.1:7820/ws',
      coreAuthToken:
        readString(qodex?.core_auth_token)
        ?? readString(qodex?.coreAuthToken)
        ?? readString(asRecord(parsed.edge)?.core_auth_token)
        ?? readString(asRecord(parsed.server)?.auth_token),
      defaultWorkspace:
        readString(qodex?.default_workspace)
        ?? readString(qodex?.defaultWorkspace)
        ?? readString(asRecord(parsed.codex)?.default_workspace),
      responseTimeoutMs:
        readInteger(qodex?.response_timeout_ms)
        ?? readInteger(qodex?.responseTimeoutMs)
        ?? 90_000,
    },
    clawbot: {
      apiBaseUrl:
        readString(clawbot?.api_base_url)
        ?? readString(clawbot?.apiBaseUrl)
        ?? 'https://www.clawbot.world',
      apiToken:
        readString(clawbot?.api_token)
        ?? readString(clawbot?.apiToken),
      messagePath:
        readString(clawbot?.message_path)
        ?? readString(clawbot?.messagePath)
        ?? '/api/v1/messages',
      defaultChannel:
        readString(clawbot?.default_channel)
        ?? readString(clawbot?.defaultChannel)
        ?? 'webchat',
      requestTimeoutMs:
        readInteger(clawbot?.request_timeout_ms)
        ?? readInteger(clawbot?.requestTimeoutMs)
        ?? 15_000,
      maxRetries:
        readInteger(clawbot?.max_retries)
        ?? readInteger(clawbot?.maxRetries)
        ?? 2,
      retryBackoffMs:
        readInteger(clawbot?.retry_backoff_ms)
        ?? readInteger(clawbot?.retryBackoffMs)
        ?? 500,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
