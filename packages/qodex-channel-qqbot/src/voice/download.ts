import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import type { QQBotVoiceConfig, VoiceAttachmentRef } from './types.js';

export interface DownloadedVoiceAttachment extends VoiceAttachmentRef {
  filePath: string;
  cleanup(): Promise<void>;
}

export async function downloadVoiceAttachment(args: {
  attachment: VoiceAttachmentRef;
  config: QQBotVoiceConfig;
  instanceId: string;
  conversationKey: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<DownloadedVoiceAttachment> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const targetPath = buildVoiceTempPath({
    tempDir: args.config.tempDir,
    instanceId: args.instanceId,
    conversationKey: args.conversationKey,
    filename: args.attachment.filename,
    url: args.attachment.url,
  });

  await mkdir(dirname(targetPath), { recursive: true });

  const response = await fetchImpl(args.attachment.url, {
    method: 'GET',
    signal: args.signal,
  });

  if (!response.ok) {
    throw new Error(`voice download failed: ${response.status} ${response.statusText}`);
  }

  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
  if (
    typeof contentLength === 'number'
    && Number.isFinite(contentLength)
    && contentLength > args.config.maxSizeBytes
  ) {
    throw new Error(`voice attachment exceeds max size ${args.config.maxSizeBytes} bytes`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > args.config.maxSizeBytes) {
    throw new Error(`voice attachment exceeds max size ${args.config.maxSizeBytes} bytes`);
  }

  await writeFile(targetPath, buffer);

  return {
    ...args.attachment,
    filePath: targetPath,
    cleanup: async () => {
      await rm(targetPath, { force: true });
    },
  };
}

export function buildVoiceTempPath(args: {
  tempDir: string;
  instanceId: string;
  conversationKey: string;
  filename?: string;
  url?: string;
  now?: number;
  randomSuffix?: string;
}): string {
  const now = args.now ?? Date.now();
  const randomSuffix = args.randomSuffix ?? randomToken();
  const extension = resolveExtension(args.filename, args.url);
  return join(
    args.tempDir,
    sanitizePathSegment(args.instanceId),
    sanitizePathSegment(args.conversationKey),
    `${now}-${randomSuffix}${extension}`,
  );
}

function resolveExtension(filename?: string, url?: string): string {
  const filenameExtension = normalizeExtension(extname(filename ?? ''));
  if (filenameExtension) {
    return filenameExtension;
  }

  const urlPath = url ? basename(url.split('?')[0] ?? '') : '';
  return normalizeExtension(extname(urlPath)) ?? '.bin';
}

function normalizeExtension(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

function sanitizePathSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'unknown';
  }
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10);
}
