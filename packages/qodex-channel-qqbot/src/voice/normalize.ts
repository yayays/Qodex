import type { QQBotVoiceConfig, VoiceTranscript } from './types.js';

export interface VoiceNormalizationResult {
  originalText: string;
  cleanText: string;
  commandText: string;
  removedFillers: string[];
  riskFlags?: string[];
  notes?: string[];
  provider?: string;
  model?: string;
  source?: 'local-rules' | 'remote-api';
}

const FILLER_PATTERNS = [
  '嗯',
  '呃',
  '额',
  '啊',
  '哦',
  '那个',
  '这个',
  '就是',
  '然后',
  '那个就是',
  '就是那个',
];

const LEADING_PHRASE_PATTERNS = [
  /^(我想问一下|我想问下|想问一下|想问下|请问一下|请问下)\s*[，,、]?\s*/u,
  /^(麻烦你|麻烦您|帮我|你帮我|给我)\s*/u,
  /^(帮我看下|帮我看一下|帮我看看|帮我瞅瞅|帮我查下|帮我查一下|帮我分析下|帮我分析一下|帮我过一遍|帮我过一下)\s*/u,
  /^(你帮我看下|你帮我看一下|你帮我看看|你帮我分析下|你帮我分析一下|你帮我过一遍)\s*/u,
  /^(给我看下|给我看一下|给我看看|给我分析下|给我分析一下|给我过一遍)\s*/u,
];

const SOFTENING_PHRASE_PATTERNS = [
  /比如说/gu,
  /比如/gu,
  /就是说/gu,
  /也就是说/gu,
];

export function normalizeVoiceTranscript(transcript: VoiceTranscript): VoiceNormalizationResult {
  const originalText = transcript.text.trim();
  const removedFillers: string[] = [];
  let working = originalText;

  for (const filler of FILLER_PATTERNS) {
    const next = working.replace(new RegExp(`(^|\\s|[，。,.!?！？])${escapeRegExp(filler)}(?=\\s|[，。,.!?！？]|$)`, 'gu'), '$1');
    if (next !== working) {
      removedFillers.push(filler);
      working = next;
    }
  }

  working = working.trim();
  working = working
    .replace(/[?？]\s*[,，、]/g, '，')
    .replace(/[,，、]\s*[?？]/g, '？')
    .replace(/\s*[,，、]\s*/g, '，')
    .replace(/\s*[;；]\s*/g, '，')
    .replace(/\s*[:：]\s*/g, '：')
    .replace(/\s*[.。]\s*/g, '。')
    .replace(/\s*[?？]\s*/g, '？')
    .replace(/\s*[!！]\s*/g, '！')
    .replace(/[，,]{2,}/g, '，')
    .replace(/[。.]{2,}/g, '。')
    .replace(/\s+/g, ' ')
    .trim();

  for (const pattern of LEADING_PHRASE_PATTERNS) {
    working = working.replace(pattern, '');
  }

  for (const pattern of SOFTENING_PHRASE_PATTERNS) {
    working = working.replace(pattern, '');
  }

  working = working
    .replace(/，?\s*你再仔细梳理一下[。.]?$/u, '。请仔细梳理。')
    .replace(/，?\s*你再仔细梳理下[。.]?$/u, '。请仔细梳理。')
    .replace(/，?\s*再仔细梳理一下[。.]?$/u, '。请仔细梳理。')
    .replace(/，?\s*再仔细梳理下[。.]?$/u, '。请仔细梳理。')
    .replace(/，?\s*仔细梳理一下[。.]?$/u, '。请仔细梳理。')
    .replace(/，?\s*仔细梳理下[。.]?$/u, '。请仔细梳理。')
    .replace(/还有什么可以改进的地方/gu, '指出可以改进的地方')
    .replace(/当前日志输出是否清晰明确[？?]?，?指出可以改进的地方。?请仔细梳理。?$/u, '评估当前日志输出是否清晰明确，并指出可以改进的地方。请仔细梳理。')
    .replace(/当前日志输出清晰明确[？?]?，?指出可以改进的地方。?请仔细梳理。?$/u, '评估当前日志输出是否清晰明确，并指出可以改进的地方。请仔细梳理。')
    .replace(/，+/g, '，')
    .replace(/。+/g, '。')
    .replace(/？+/g, '？')
    .replace(/^，+/u, '')
    .replace(/[，。？]+$/u, '')
    .trim();

  working = finalizeCommandText(working);

  if (!working) {
    working = originalText;
  }

  return {
    originalText,
    cleanText: working,
    commandText: working,
    removedFillers,
    source: 'local-rules',
  };
}

interface VoiceApiNormalizeResponse {
  original_text?: string;
  clean_text?: string;
  command_text?: string;
  risk_flags?: string[];
  notes?: string[];
  provider?: string;
  model?: string;
}

export async function normalizeVoiceTranscriptWithConfig(args: {
  transcript: VoiceTranscript;
  config: QQBotVoiceConfig;
  fetchImpl?: typeof fetch;
  log?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}): Promise<VoiceNormalizationResult> {
  const fallback = normalizeVoiceTranscript(args.transcript);
  const normalizeConfig = args.config.normalize;
  if (!normalizeConfig.enabled) {
    args.log?.info?.('voice normalize disabled, using local rules');
    return fallback;
  }

  if (!normalizeConfig.apiBaseUrl) {
    args.log?.info?.('voice normalize apiBaseUrl not configured, using local rules');
    return fallback;
  }

  try {
    const fetchImpl = args.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (normalizeConfig.apiKeyEnv) {
      const apiKey = process.env[normalizeConfig.apiKeyEnv];
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
    }

    const response = await fetchImpl(normalizeConfig.apiBaseUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(normalizeConfig.timeoutMs),
      headers,
      body: JSON.stringify({
        text: args.transcript.text,
        mode: 'command',
        language: args.transcript.language ?? args.config.stt.language ?? 'zh',
        strip_fillers: normalizeConfig.stripFillers,
        preserve_explicit_slash_commands: normalizeConfig.preserveExplicitSlashCommands,
        model: normalizeConfig.model,
      }),
    });

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      args.log?.warn?.(
        `voice normalize via voiceApi failed status=${response.status} status_text="${response.statusText}" detail="${detail ?? 'n/a'}"; falling back to local rules`,
      );
      return fallback;
    }

    const payload = (await response.json()) as VoiceApiNormalizeResponse;
    const cleanText = payload.clean_text?.trim();
    const commandText = payload.command_text?.trim();
    if (!cleanText || !commandText) {
      args.log?.warn?.(
        'voice normalize via voiceApi returned incomplete payload, falling back to local rules',
      );
      return fallback;
    }

    return {
      originalText: payload.original_text?.trim() || fallback.originalText,
      cleanText,
      commandText,
      removedFillers: fallback.removedFillers,
      riskFlags: Array.isArray(payload.risk_flags) ? payload.risk_flags : undefined,
      notes: Array.isArray(payload.notes) ? payload.notes : undefined,
      provider: payload.provider,
      model: payload.model,
      source: 'remote-api',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.log?.warn?.(
      `voice normalize request to voiceApi failed: ${message}; falling back to local rules`,
    );
    return fallback;
  }
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const cloned = response.clone();
    const contentType = cloned.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const payload = await cloned.json() as { detail?: unknown };
      if (typeof payload.detail === 'string' && payload.detail.trim()) {
        return payload.detail.trim();
      }
      return JSON.stringify(payload);
    }

    const text = (await cloned.text()).trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function finalizeCommandText(value: string): string {
  let next = value
    .replace(/日志打印/u, '日志输出')
    .replace(/，?是否指出可以改进的地方/u, '，并指出可以改进的地方')
    .replace(/是否清晰明确/u, '是否清晰明确')
    .replace(/^看看/u, '查看')
    .replace(/^看下/u, '查看')
    .replace(/^分析下/u, '分析')
    .replace(/^分析一下/u, '分析')
    .replace(/^过一遍/u, '检查一遍')
    .replace(/^过一下/u, '检查一下')
    .replace(/，?\s*顺便看看/gu, '，并查看')
    .replace(/，?\s*顺便看下/gu, '，并查看')
    .replace(/，?\s*顺便看一下/gu, '，并看一下')
    .replace(/，?\s*顺便分析下/gu, '，并分析')
    .replace(/，?\s*顺便分析一下/gu, '，并分析')
    .trim();

  if (
    /当前.+日志输出/u.test(next)
    && /清晰明确/u.test(next)
    && /改进/u.test(next)
    && /仔细梳理/u.test(next)
  ) {
    return '评估当前日志输出是否清晰明确，并指出可以改进的地方。请仔细梳理。';
  }

  if (/^当前.+是否清晰明确/u.test(next) && /改进/u.test(next)) {
    next = `评估${next}`;
  }

  if (!/[。！？]$/u.test(next) && /[，。！？]/u.test(next)) {
    next = `${next}。`;
  }

  return next;
}
