import type {
  ChannelPlugin,
  ChannelSendTextParams,
  QodexPluginApi,
  QodexPluginExtension,
} from '@qodex/edge';
import { emptyPluginConfigSchema } from '@qodex/edge';

import {
  sendQQBotText,
} from './api.js';
import {
  QQBotChannelConfig,
  qqbotPluginConfigSchema,
  resolveQQBotChannelConfig,
} from './config.js';
import {
  chunkQQText,
  looksLikeQQBotTarget,
  normalizeQQBotTarget,
  parseQQBotTarget,
} from './target.js';
import { qqbotPlatformForInstance, startQQBotGateway } from './gateway.js';

export const qqbotChannelPlugin: ChannelPlugin = {
  id: 'qqbot',
  meta: {
    id: 'qqbot',
    label: 'QQ Bot',
    selectionLabel: 'QQ Bot (Qodex standalone channel)',
    blurb: 'Standalone QQ text channel adapted from OpenClaw-style qqbot semantics.',
    order: 30,
  },
  capabilities: {
    chatTypes: ['c2c', 'group', 'channel'],
    media: false,
    reactions: false,
    threads: false,
  },
  messaging: {
    normalizeTarget(target: string) {
      return normalizeQQBotTarget(target);
    },
    conversationPlatforms(entry) {
      return [qqbotPlatformForInstance(entry.instanceId)];
    },
    buildTargetFromConversation(conversation) {
      return normalizeQQBotTarget(`qqbot:${conversation.scope}:${conversation.externalId}`);
    },
    targetResolver: {
      looksLikeId(value: string) {
        return looksLikeQQBotTarget(value);
      },
      hint: 'Use qqbot:c2c:<openid>, qqbot:group:<group_openid>, or qqbot:channel:<channel_id>.',
    },
  },
  outbound: {
    async sendText(params: ChannelSendTextParams) {
      const config = await resolveOutboundConfig(params);
      const target = parseQQBotTarget(normalizeQQBotTarget(params.to));
      if (!target) {
        throw new Error(`invalid qqbot target: ${params.to}`);
      }

      for (const chunk of chunkQQText(params.text)) {
        await sendQQBotText(config, target, chunk, params.replyToId);
      }

      return {};
    },
  },
  gateway: {
    async startAccount(context) {
      await startQQBotGateway(context);
    },
  },
};

const qodexQQBotPluginDefinition = {
  id: 'qodex-channel-qqbot',
  name: 'Qodex QQ Bot Channel',
  description:
    'Standalone QQ channel for Qodex. Supports outbound text and inbound QQ message dispatch through the gateway.',
  apiVersion: 1,
  supportedApiVersions: [1],
  capabilities: [
    'channel.register',
    'channel.gateway',
    'channel.outbound.text',
    'runtime.dispatchInbound',
    'runtime.getChannelEntry',
  ],
  configSchema: {
    ...emptyPluginConfigSchema(),
    ...qqbotPluginConfigSchema,
  },
  register(api: QodexPluginApi) {
    api.registerChannel({ plugin: qqbotChannelPlugin });
  },
};

export const qodexQQBotPlugin: QodexPluginExtension = qodexQQBotPluginDefinition;

export default qodexQQBotPlugin;

export type { QQBotChannelConfig } from './config.js';
export * from './allow.js';
export * from './config.js';
export * from './target.js';
export * from './voice/config.js';
export * from './voice/detect.js';
export * from './voice/download.js';
export * from './voice/confirm.js';
export * from './voice/normalize.js';
export * from './voice/stt.js';
export * from './voice/types.js';

async function resolveOutboundConfig(
  params: ChannelSendTextParams,
): Promise<QQBotChannelConfig> {
  return await resolveQQBotChannelConfig(
    params.entry?.config ?? {},
    params.entry?.configDir,
  );
}
