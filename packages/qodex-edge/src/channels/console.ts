import {
  ChannelPlugin,
  ChannelSendTextParams,
  QodexPluginExtension,
  buildChannelAddress,
  emptyPluginConfigSchema,
} from '../plugin-sdk.js';

export const consoleChannelPlugin: ChannelPlugin = {
  id: 'console',
  meta: {
    id: 'console',
    label: 'Console',
    selectionLabel: 'Console (local dev channel)',
    blurb: 'Local development channel that prints replies to stdout.',
    order: 10,
  },
  capabilities: {
    chatTypes: ['c2c', 'group', 'channel'],
    media: false,
    reactions: false,
    threads: false,
  },
  messaging: {
    normalizeTarget(target: string) {
      return target.includes(':') ? target : buildChannelAddress('console', 'c2c', target);
    },
    conversationPlatforms() {
      return ['console'];
    },
    buildTargetFromConversation(conversation) {
      return conversation.conversationKey;
    },
    targetResolver: {
      looksLikeId(value: string) {
        return value.trim().length > 0;
      },
      hint: 'Any non-empty local target id is accepted.',
    },
  },
  outbound: {
    async sendText(params: ChannelSendTextParams) {
      writeConsoleLine(params);
      return {};
    },
    async sendStreamUpdate(params: ChannelSendTextParams) {
      writeConsoleLine(params);
      return {};
    },
  },
  gateway: {
    async startAccount(context) {
      context.log.info(
        {
          channel: 'console',
          instanceId: context.account.instanceId,
          accountId: context.account.accountId ?? 'default',
        },
        'console channel ready',
      );
      context.setStatus({
        connected: true,
        accountId: context.account.accountId ?? 'default',
      });
    },
  },
};

export const consoleChannelExtension: QodexPluginExtension = {
  id: 'qodex-console-channel',
  name: 'Qodex Console Channel',
  description: 'Built-in local channel for driving Qodex without a real IM gateway.',
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerChannel({ plugin: consoleChannelPlugin });
  },
};

function writeConsoleLine(params: ChannelSendTextParams): void {
  const label = params.kind.toUpperCase();
  const suffix = params.turnId ? `#${params.turnId}` : '';
  console.log(`[${label}][${params.to}${suffix}] ${params.text}`);
}
