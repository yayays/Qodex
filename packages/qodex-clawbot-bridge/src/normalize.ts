import type { ClawbotBridgeConfig, ClawbotInboundEvent, NormalizedClawbotInbound } from './types.js';

export function normalizeClawbotInbound(
  payload: ClawbotInboundEvent,
  config: ClawbotBridgeConfig,
): NormalizedClawbotInbound {
  const text =
    readString(payload.content)
    ?? readString(payload.text)
    ?? readString(payload.message?.content)
    ?? readString(payload.message?.text);
  if (!text) {
    throw new Error('clawbot inbound payload did not contain message text');
  }

  const replyChannel = normalizeChannel(
    readString(payload.channel) ?? config.clawbot.defaultChannel,
  );
  const replyContextId =
    readString(payload.context_id)
    ?? readString(payload.contextId)
    ?? readString(payload.room_id)
    ?? readString(payload.roomId)
    ?? readString(payload.chat_id)
    ?? readString(payload.chatId)
    ?? readString(payload.sender_id)
    ?? readString(payload.senderId)
    ?? readString(payload.contact_id)
    ?? readString(payload.contactId)
    ?? readString(payload.user_id)
    ?? readString(payload.userId);
  if (!replyContextId) {
    throw new Error('clawbot inbound payload did not contain a context identifier');
  }

  const senderId =
    readString(payload.sender_id)
    ?? readString(payload.senderId)
    ?? readString(payload.contact_id)
    ?? readString(payload.contactId)
    ?? readString(payload.user_id)
    ?? readString(payload.userId)
    ?? replyContextId;

  const isGroup = Boolean(
    readString(payload.room_id)
    ?? readString(payload.roomId)
    ?? readString(payload.chat_id)
    ?? readString(payload.chatId),
  );
  const scope = isGroup ? 'group' : 'c2c';

  return {
    text,
    conversation: {
      conversationKey: `${replyChannel}:${scope}:${replyContextId}`,
      platform: replyChannel,
      scope,
      externalId: replyContextId,
    },
    sender: {
      senderId,
      displayName:
        readString(payload.sender_name)
        ?? readString(payload.senderName)
        ?? readString(payload.user_name)
        ?? readString(payload.userName),
    },
    replyContextId,
    replyChannel,
    replyToMessageId: readString(payload.message_id) ?? readString(payload.messageId),
    raw: payload,
  };
}

function normalizeChannel(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return 'webchat';
  }
  if (trimmed === 'wechat') {
    return 'webchat';
  }
  return trimmed;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
