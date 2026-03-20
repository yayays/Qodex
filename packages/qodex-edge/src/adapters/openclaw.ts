import { QodexEdgeRuntime } from '../runtime.js';
import { ConversationRef, OutboundSink, PlatformMessage } from '../protocol.js';

export interface OpenClawLikeMessage {
  platform?: string;
  scope: 'c2c' | 'group' | 'channel';
  targetId: string;
  text: string;
  senderId: string;
  senderName?: string;
  workspace?: string;
}

export interface OpenClawDeliver {
  sendText(targetId: string, text: string): Promise<void>;
  sendStreamUpdate?(targetId: string, text: string): Promise<void>;
}

export class OpenClawSink implements OutboundSink {
  constructor(
    private readonly targetId: string,
    private readonly deliver: OpenClawDeliver,
  ) {}

  async sendText(message: { text: string }): Promise<void> {
    await this.deliver.sendText(this.targetId, message.text);
  }

  async sendStreamUpdate(message: { text: string }): Promise<void> {
    if (!this.deliver.sendStreamUpdate) {
      return;
    }
    await this.deliver.sendStreamUpdate(this.targetId, message.text);
  }
}

export class QodexOpenClawAdapter {
  constructor(private readonly runtime: QodexEdgeRuntime) {}

  async handleMessage(message: OpenClawLikeMessage, deliver: OpenClawDeliver): Promise<void> {
    const conversation = normalizeConversation(message);
    const sink = new OpenClawSink(message.targetId, deliver);

    const platformMessage: PlatformMessage = {
      conversation,
      sender: {
        senderId: message.senderId,
        displayName: message.senderName,
      },
      text: message.text,
      workspace: message.workspace,
    };

    await this.runtime.handleIncoming(platformMessage, sink);
  }
}

export function normalizeConversation(message: OpenClawLikeMessage): ConversationRef {
  const platform = message.platform ?? 'qqbot';
  return {
    conversationKey: `${platform}:${message.scope}:${message.targetId}`,
    platform,
    scope: message.scope,
    externalId: message.targetId,
  };
}

export function createOpenClawPlugin(runtime: QodexEdgeRuntime) {
  const adapter = new QodexOpenClawAdapter(runtime);
  return {
    id: 'qodex',
    name: 'Qodex',
    version: '0.1.0',
    adapter,
    async register(api: { registerChannel?: (channel: unknown) => void }) {
      if (!api?.registerChannel) {
        return;
      }

      api.registerChannel({
        plugin: {
          id: 'qodex',
          title: 'Qodex QQ Bridge',
          async handleInbound(message: OpenClawLikeMessage, deliver: OpenClawDeliver) {
            await adapter.handleMessage(message, deliver);
          },
        },
      });
    },
  };
}
