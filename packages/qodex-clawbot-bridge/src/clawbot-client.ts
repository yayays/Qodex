import type { ClawbotBridgeConfig } from './types.js';

export async function sendClawbotMessage(args: {
  config: ClawbotBridgeConfig;
  content: string;
  contextId: string;
  channel?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = new URL(args.config.clawbot.messagePath, args.config.clawbot.apiBaseUrl).toString();
  let attempt = 0;
  while (true) {
    attempt += 1;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(args.config.clawbot.apiToken
          ? { Authorization: `Bearer ${args.config.clawbot.apiToken}` }
          : {}),
      },
      signal: AbortSignal.timeout(args.config.clawbot.requestTimeoutMs),
      body: JSON.stringify({
        content: args.content,
        channel: args.channel ?? args.config.clawbot.defaultChannel,
        context_id: args.contextId,
      }),
    });

    if (response.ok) {
      return;
    }

    const detail = await response.text().catch(() => '');
    if (attempt > args.config.clawbot.maxRetries) {
      throw new Error(
        `clawbot message send failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`,
      );
    }

    await sleep(args.config.clawbot.retryBackoffMs * attempt);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
