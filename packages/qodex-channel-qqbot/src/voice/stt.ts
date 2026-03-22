import { readFile } from 'node:fs/promises';

import type { DownloadedVoiceAttachment } from './download.js';
import type { QQBotVoiceConfig, QQBotVoiceSttConfig, VoiceTranscript } from './types.js';

export interface VoiceSttProvider {
  readonly id: string;
  transcribe(args: {
    attachment: DownloadedVoiceAttachment;
    config: QQBotVoiceConfig;
    signal: AbortSignal;
  }): Promise<VoiceTranscript>;
}

interface RemoteWhisperResponseSegment {
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
}

interface RemoteWhisperResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: RemoteWhisperResponseSegment[];
}

export function createVoiceSttProvider(
  config: QQBotVoiceSttConfig,
  fetchImpl: typeof fetch = fetch,
): VoiceSttProvider {
  const providerId = config.provider?.trim().toLowerCase();
  if (!providerId) {
    throw new Error('voice transcription provider is not configured');
  }

  switch (providerId) {
    case 'remote-whisper':
      return createRemoteWhisperProvider(config, fetchImpl);
    default:
      throw new Error(`unsupported voice transcription provider: ${config.provider}`);
  }
}

export async function transcribeVoiceAttachment(args: {
  attachment: DownloadedVoiceAttachment;
  config: QQBotVoiceConfig;
  signal: AbortSignal;
  provider?: VoiceSttProvider;
  fetchImpl?: typeof fetch;
}): Promise<VoiceTranscript> {
  const provider =
    args.provider ?? createVoiceSttProvider(args.config.stt, args.fetchImpl ?? fetch);
  return await provider.transcribe({
    attachment: args.attachment,
    config: args.config,
    signal: args.signal,
  });
}

function createRemoteWhisperProvider(
  config: QQBotVoiceSttConfig,
  fetchImpl: typeof fetch,
): VoiceSttProvider {
  return {
    id: 'remote-whisper',
    async transcribe(args) {
      const apiBaseUrl = config.apiBaseUrl?.trim();
      if (!apiBaseUrl) {
        throw new Error('remote-whisper requires stt.apiBaseUrl');
      }

      const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
      if (config.apiKeyEnv && !apiKey) {
        throw new Error(`voice transcription API key env is not set: ${config.apiKeyEnv}`);
      }

      const fileBuffer = await readFile(args.attachment.filePath);
      const form = new FormData();
      const mimeType = args.attachment.mimeType?.trim() || 'application/octet-stream';
      const filename = args.attachment.filename?.trim() || 'voice-input.bin';

      form.append(
        'file',
        new Blob([fileBuffer], { type: mimeType }),
        filename,
      );

      if (config.model) {
        form.append('model', config.model);
      }
      if (config.language) {
        form.append('language', config.language);
      }
      form.append('response_format', 'json');

      const response = await fetchImpl(apiBaseUrl, {
        method: 'POST',
        signal: args.signal,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        body: form,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `voice transcription failed: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`,
        );
      }

      const payload = (await response.json()) as RemoteWhisperResponse;
      const text = payload.text?.trim() ?? '';
      if (!text) {
        throw new Error('voice transcription returned empty text');
      }

      return {
        text,
        language: payload.language,
        durationMs:
          typeof payload.duration === 'number' && Number.isFinite(payload.duration)
            ? Math.round(payload.duration * 1000)
            : args.attachment.durationMs,
        provider: 'remote-whisper',
        segments: payload.segments?.flatMap((segment) => {
          if (!segment.text?.trim()) {
            return [];
          }
          return [{
            startMs:
              typeof segment.start === 'number' && Number.isFinite(segment.start)
                ? Math.round(segment.start * 1000)
                : 0,
            endMs:
              typeof segment.end === 'number' && Number.isFinite(segment.end)
                ? Math.round(segment.end * 1000)
                : 0,
            text: segment.text.trim(),
            confidence:
              typeof segment.avg_logprob === 'number' && Number.isFinite(segment.avg_logprob)
                ? segment.avg_logprob
                : undefined,
          }];
        }),
      };
    },
  };
}
