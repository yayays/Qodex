import type { ChannelInboundMessage, ChannelSendTextParams } from '../../plugin-contract.js';
import type { WechatCompatInboundEvent, WechatCompatSendTextParams } from './types.js';

export function toChannelInboundMessage(params: {
  channelId: string;
  platform: string;
  accountId?: string;
  event: WechatCompatInboundEvent;
}): ChannelInboundMessage {
  return {
    channelId: params.channelId,
    platform: params.platform,
    scope: params.event.scope,
    targetId: params.event.targetId,
    text: params.event.text,
    senderId: params.event.senderId,
    senderName: params.event.senderName,
    accountId: params.accountId,
    to: params.event.targetId,
    replyToId: params.event.replyToId,
    images: params.event.images,
    files: params.event.files,
    raw: params.event.raw,
  };
}

export function toWechatCompatSendTextParams(
  params: ChannelSendTextParams,
): WechatCompatSendTextParams {
  return {
    to: params.to,
    text: params.text,
    accountId: params.accountId,
  };
}
