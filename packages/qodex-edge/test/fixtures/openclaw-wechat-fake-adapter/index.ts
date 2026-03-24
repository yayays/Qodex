type FakeState = {
  started: number;
  stopped: number;
  sentTexts: Array<{
    to: string;
    text: string;
    accountId?: string;
  }>;
};

const state: FakeState = {
  started: 0,
  stopped: 0,
  sentTexts: [],
};

export function resetFakeWechatAdapterState(): void {
  state.started = 0;
  state.stopped = 0;
  state.sentTexts = [];
}

export function getFakeWechatAdapterState(): FakeState {
  return {
    started: state.started,
    stopped: state.stopped,
    sentTexts: [...state.sentTexts],
  };
}

export function createAdapter(params: {
  config: Record<string, unknown>;
  accountId?: string;
  host: {
    emitQrCode(event: { value: string; format?: string; expiresAt?: number; note?: string }): void;
    setConnection(event: {
      connected: boolean;
      loginState?: string;
      accountId?: string;
      lastError?: string;
    }): void;
    receiveMessage(event: {
      scope: 'c2c' | 'group';
      targetId: string;
      senderId: string;
      senderName?: string;
      text: string;
      replyToId?: string;
    }): Promise<void>;
  };
}) {
  return {
    async start() {
      state.started += 1;

      if (params.config.emit_qr_on_start) {
        params.host.emitQrCode({
          value: 'https://qr.example.test/session-1',
          format: 'url',
          note: 'scan to connect',
        });
      }

      if (params.config.connect_on_start) {
        params.host.setConnection({
          connected: true,
          loginState: 'connected',
          accountId: params.accountId,
        });
      }

      const inboundMessages = Array.isArray(params.config.inbound_messages)
        ? params.config.inbound_messages
        : [];
      for (const message of inboundMessages) {
        const record = message as Record<string, unknown>;
        await params.host.receiveMessage({
          scope: (record.scope as 'c2c' | 'group') ?? 'c2c',
          targetId: String(record.target_id ?? ''),
          senderId: String(record.sender_id ?? ''),
          senderName: typeof record.sender_name === 'string' ? record.sender_name : undefined,
          text: String(record.text ?? ''),
          replyToId: typeof record.reply_to_id === 'string' ? record.reply_to_id : undefined,
        });
      }
    },

    async stop() {
      state.stopped += 1;
    },

    async sendText(params: {
      to: string;
      text: string;
      accountId?: string;
    }) {
      state.sentTexts.push({
        to: params.to,
        text: params.text,
        accountId: params.accountId,
      });
      return {
        messageId: `fake-message-${state.sentTexts.length}`,
      };
    },
  };
}

export default {
  createAdapter,
};
