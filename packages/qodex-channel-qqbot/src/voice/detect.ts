import type { QQBotMessageAttachment } from '../types.js';
import type { QQBotVoiceConfig, VoiceAttachmentRef } from './types.js';

const AUDIO_EXTENSION_RE = /\.(aac|amr|m4a|mp3|ogg|opus|silk|wav)$/i;

export function findVoiceAttachments(
  attachments: QQBotMessageAttachment[] | undefined,
  config: QQBotVoiceConfig,
): VoiceAttachmentRef[] {
  if (!config.enabled) {
    return [];
  }

  const results: VoiceAttachmentRef[] = [];
  for (const attachment of attachments ?? []) {
    const voiceRef = toVoiceAttachmentRef(attachment, config);
    if (voiceRef) {
      results.push(voiceRef);
    }
  }
  return results;
}

export function isVoiceAttachment(
  attachment: QQBotMessageAttachment,
  config: QQBotVoiceConfig,
): boolean {
  if (!attachment.url) {
    return false;
  }

  const mimeType = attachment.content_type?.trim().toLowerCase();
  if (mimeType && mimeType.startsWith('audio/')) {
    return config.allowedMimeTypes.includes(mimeType);
  }

  const extension = getAttachmentExtension(attachment);
  return extension ? config.allowedExtensions.includes(extension) : false;
}

function toVoiceAttachmentRef(
  attachment: QQBotMessageAttachment,
  config: QQBotVoiceConfig,
): VoiceAttachmentRef | undefined {
  if (!isVoiceAttachment(attachment, config) || !attachment.url) {
    return undefined;
  }

  return {
    url: attachment.url,
    mimeType: attachment.content_type,
    filename: attachment.filename,
    sizeBytes: attachment.size,
    durationMs: attachment.duration,
    source: 'attachment',
  };
}

function getAttachmentExtension(attachment: QQBotMessageAttachment): string | undefined {
  const filename = attachment.filename?.trim().toLowerCase();
  if (filename) {
    const match = /\.([a-z0-9]+)$/.exec(filename);
    if (match?.[1] && AUDIO_EXTENSION_RE.test(filename)) {
      return match[1];
    }
  }

  const url = attachment.url?.trim().toLowerCase();
  if (!url) {
    return undefined;
  }
  const path = url.split('?')[0] ?? '';
  const match = /\.([a-z0-9]+)$/.exec(path);
  if (match?.[1] && AUDIO_EXTENSION_RE.test(path)) {
    return match[1];
  }
  return undefined;
}
