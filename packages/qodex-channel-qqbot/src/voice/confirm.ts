import type { ChannelScope } from '@qodex/edge';

import type { QQBotVoiceConfig, VoiceTranscript } from './types.js';
import type { VoiceNormalizationResult } from './normalize.js';

export interface VoiceConfirmationDecision {
  requiresConfirmation: boolean;
  reasons: string[];
  riskFlags: string[];
}

export interface PendingVoiceConfirmation {
  instanceId: string;
  scope: ChannelScope;
  targetId: string;
  senderId: string;
  senderName?: string;
  accountId?: string;
  platform: string;
  replyToId?: string;
  event: unknown;
  transcript: VoiceTranscript;
  normalized: VoiceNormalizationResult;
  createdAt: number;
  expiresAt: number;
}

const pendingVoiceConfirmations = new Map<string, PendingVoiceConfirmation>();
const DESTRUCTIVE_RE =
  /(删除|清空|重置|回滚|覆盖|强制推送|提交并推送|git reset|git push|git revert|rm\s|rm$|drop\s|drop$|delete\b|reset\b|revert\b)/iu;
const AMBIGUOUS_RE = /(这个|那个|刚才那个|处理一下|搞一下|弄一下)/u;
const CONFIRM_RE = /^(确认|继续|执行|yes|y|confirm)$/iu;
const CANCEL_RE = /^(取消|不用了|算了|no|n|cancel)$/iu;

export function evaluateVoiceConfirmationPolicy(args: {
  config: QQBotVoiceConfig;
  transcript: VoiceTranscript;
  normalized: VoiceNormalizationResult;
  scope: ChannelScope;
}): VoiceConfirmationDecision {
  const reasons: string[] = [];
  const riskFlags: string[] = [];

  if (!args.config.autoSend) {
    reasons.push('auto-send disabled');
  }

  if (
    typeof args.transcript.confidence === 'number'
    && args.transcript.confidence < args.config.requireConfirmationBelowConfidence
  ) {
    reasons.push('low confidence transcript');
  }

  if (DESTRUCTIVE_RE.test(args.normalized.commandText)) {
    riskFlags.push('destructive-action');
  }
  if (
    args.scope !== 'c2c'
    && AMBIGUOUS_RE.test(args.normalized.commandText)
  ) {
    riskFlags.push('ambiguous-group-reference');
  }
  if (
    !args.config.normalize.preserveExplicitSlashCommands
    && args.normalized.commandText.startsWith('/')
  ) {
    riskFlags.push('slash-command');
  }

  if (riskFlags.length > 0) {
    reasons.push(...riskFlags);
  }

  return {
    requiresConfirmation: reasons.length > 0,
    reasons,
    riskFlags,
  };
}

export function savePendingVoiceConfirmation(entry: PendingVoiceConfirmation): void {
  pendingVoiceConfirmations.set(buildPendingVoiceConfirmationKey(entry), entry);
}

export function peekPendingVoiceConfirmation(args: {
  instanceId: string;
  scope: ChannelScope;
  targetId: string;
  senderId: string;
}): PendingVoiceConfirmation | undefined {
  const key = buildPendingVoiceConfirmationKey(args);
  const entry = pendingVoiceConfirmations.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    pendingVoiceConfirmations.delete(key);
    return undefined;
  }
  return entry;
}

export function consumePendingVoiceConfirmation(args: {
  instanceId: string;
  scope: ChannelScope;
  targetId: string;
  senderId: string;
}): PendingVoiceConfirmation | undefined {
  const key = buildPendingVoiceConfirmationKey(args);
  const entry = peekPendingVoiceConfirmation(args);
  if (!entry) {
    return undefined;
  }
  pendingVoiceConfirmations.delete(key);
  return entry;
}

export function clearPendingVoiceConfirmations(): void {
  pendingVoiceConfirmations.clear();
}

export function parseVoiceConfirmationIntent(text: string): 'confirm' | 'cancel' | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  if (CONFIRM_RE.test(trimmed)) {
    return 'confirm';
  }
  if (CANCEL_RE.test(trimmed)) {
    return 'cancel';
  }
  return undefined;
}

export function formatVoiceConfirmationRequest(args: {
  transcript: VoiceTranscript;
  normalized: VoiceNormalizationResult;
  decision: VoiceConfirmationDecision;
}): string {
  const lines = [
    `Voice transcript: ${args.transcript.text}`,
    `Normalized command: ${args.normalized.commandText}`,
    `Confirmation required: ${args.decision.reasons.join(', ')}`,
    'Reply "确认" to continue or "取消" to abort.',
  ];
  return lines.join('\n');
}

function buildPendingVoiceConfirmationKey(args: {
  instanceId: string;
  scope: ChannelScope;
  targetId: string;
  senderId: string;
}): string {
  return `${args.instanceId}:${args.scope}:${args.targetId}:${args.senderId}`;
}
