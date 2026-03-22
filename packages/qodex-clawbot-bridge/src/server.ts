import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { sendClawbotMessage } from './clawbot-client.js';
import { normalizeClawbotInbound } from './normalize.js';
import { sendToQodexAndWait } from './qodex-turn.js';
import type { ClawbotBridgeConfig, ClawbotInboundEvent } from './types.js';

export async function handleClawbotWebhook(
  payload: ClawbotInboundEvent,
  config: ClawbotBridgeConfig,
  deps: {
    sendToQodex?: typeof sendToQodexAndWait;
    sendClawbot?: typeof sendClawbotMessage;
  } = {},
): Promise<{ ok: true; conversationKey: string }> {
  const sendToQodex = deps.sendToQodex ?? sendToQodexAndWait;
  const sendClawbot = deps.sendClawbot ?? sendClawbotMessage;
  const inbound = normalizeClawbotInbound(payload, config);
  const replyText = await sendToQodex({
    config,
    conversation: inbound.conversation,
    sender: inbound.sender,
    text: inbound.text,
  });
  await sendClawbot({
    config,
    content: replyText,
    contextId: inbound.replyContextId,
    channel: inbound.replyChannel,
  });

  return {
    ok: true,
    conversationKey: inbound.conversation.conversationKey,
  };
}

export function createClawbotBridgeServer(
  config: ClawbotBridgeConfig,
  deps: {
    sendToQodex?: typeof sendToQodexAndWait;
    sendClawbot?: typeof sendClawbotMessage;
  } = {},
) {
  const sendToQodex = deps.sendToQodex ?? sendToQodexAndWait;
  const sendClawbot = deps.sendClawbot ?? sendClawbotMessage;

  return createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== config.server.path) {
        writeJson(res, 404, { error: 'not_found' });
        return;
      }

      validateWebhookSignature(req, config);

      const payload = await readJsonBody(req);
      const result = await handleClawbotWebhook(payload as ClawbotInboundEvent, config, {
        sendToQodex,
        sendClawbot,
      });
      writeJson(res, 200, result);
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function validateWebhookSignature(req: IncomingMessage, config: ClawbotBridgeConfig): void {
  if (!config.server.signatureHeader || !config.server.signatureToken) {
    return;
  }

  const headerName = config.server.signatureHeader.toLowerCase();
  const headerValue = req.headers[headerName];
  const provided = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!provided) {
    throw new Error(`missing webhook signature header: ${config.server.signatureHeader}`);
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(config.server.signatureToken);
  if (
    providedBuffer.length !== expectedBuffer.length
    || !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new Error('invalid webhook signature');
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8').trim();
  return body ? JSON.parse(body) : {};
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
