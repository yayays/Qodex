export interface QQBotVoiceSttConfig {
  provider?: string;
  language?: string;
  model?: string;
  apiBaseUrl?: string;
  apiKeyEnv?: string;
  timeoutMs: number;
}

export interface QQBotVoiceNormalizeConfig {
  enabled: boolean;
  provider?: string;
  model?: string;
  apiBaseUrl?: string;
  apiKeyEnv?: string;
  timeoutMs: number;
  stripFillers: boolean;
  preserveExplicitSlashCommands: boolean;
}

export interface QQBotVoiceConfig {
  enabled: boolean;
  autoSend: boolean;
  confirmationTtlMs: number;
  requireConfirmationBelowConfidence: number;
  maxDurationMs: number;
  maxSizeBytes: number;
  tempDir: string;
  cleanupAfterSeconds: number;
  allowedMimeTypes: string[];
  allowedExtensions: string[];
  ffmpegPath?: string;
  stt: QQBotVoiceSttConfig;
  normalize: QQBotVoiceNormalizeConfig;
}

export interface VoiceAttachmentRef {
  url: string;
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  durationMs?: number;
  source: 'attachment' | 'event-audio';
}

export interface VoiceTranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
}

export interface VoiceTranscript {
  text: string;
  confidence?: number;
  language?: string;
  durationMs?: number;
  provider: string;
  segments?: VoiceTranscriptSegment[];
}
