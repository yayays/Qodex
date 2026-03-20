import { OutboundSink, OutboundTextMessage, StreamUpdateMessage } from '../protocol.js';

export class ConsoleSink implements OutboundSink {
  async sendText(message: OutboundTextMessage): Promise<void> {
    const prefix = `[${message.kind.toUpperCase()}][${message.conversationKey}]`;
    console.log(`${prefix} ${message.text}`);
  }

  async sendStreamUpdate(message: StreamUpdateMessage): Promise<void> {
    const prefix = `[STREAM][${message.conversationKey}][${message.turnId}]`;
    console.log(`${prefix} ${message.text}`);
  }
}
