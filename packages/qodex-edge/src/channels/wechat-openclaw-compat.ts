import {
  ChannelPlugin,
  ChannelSendTextParams,
  QodexPluginExtension,
  emptyPluginConfigSchema,
} from '../plugin-sdk.js';
import { getWechatCompatSession, startWechatCompatSession, stopWechatCompatSession } from './wechat-openclaw-compat/session.js';
import { toWechatCompatSendTextParams } from './wechat-openclaw-compat/translate.js';

export const wechatOpenClawCompatChannelPlugin: ChannelPlugin = {
  id: 'wechat-openclaw-compat',
  meta: {
    id: 'wechat-openclaw-compat',
    label: 'WeChat Compat',
    selectionLabel: 'WeChat Compat (OpenClaw transport seam)',
    blurb: 'Minimal WeChat channel that bridges QR login and text messaging into Qodex.',
    order: 80,
  },
  capabilities: {
    chatTypes: ['c2c', 'group'],
    media: false,
    reactions: false,
    threads: false,
    blockStreaming: true,
  },
  messaging: {
    conversationPlatforms() {
      return ['webchat', 'wechat'];
    },
    buildTargetFromConversation(conversation) {
      return conversation.externalId;
    },
    targetResolver: {
      looksLikeId(value: string) {
        return value.trim().length > 0;
      },
      hint: 'Use the raw WeChat peer or room id.',
    },
  },
  outbound: {
    async sendText(params: ChannelSendTextParams) {
      const session = getRequiredSession(params);
      return session.adapter.sendText(toWechatCompatSendTextParams(params));
    },
  },
  gateway: {
    async startAccount(context) {
      await startWechatCompatSession(context);
    },
    async stopAccount(context) {
      await stopWechatCompatSession(context);
    },
  },
};

export const wechatOpenClawCompatExtension: QodexPluginExtension = {
  id: 'qodex-wechat-openclaw-compat',
  name: 'Qodex WeChat OpenClaw Compatibility',
  description: 'Built-in compatibility channel for a narrow WeChat QR-login transport seam.',
  apiVersion: 1,
  supportedApiVersions: [1],
  capabilities: [
    'channel.register',
    'channel.gateway',
    'channel.outbound.text',
  ],
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerChannel({ plugin: wechatOpenClawCompatChannelPlugin });
  },
};

function getRequiredSession(params: ChannelSendTextParams) {
  const instanceId = params.entry?.instanceId;
  const session = getWechatCompatSession(instanceId);
  if (!session) {
    throw new Error(
      `wechat compat session is not active for instance "${instanceId ?? 'unknown'}"`,
    );
  }
  return session;
}
