import { CoreClient, CoreEvents } from '@qodex/edge';
import type {
  ApprovalRequestedEvent,
  ConversationCompletedEvent,
  ConversationDeltaEvent,
  ConversationErrorEvent,
  ConversationRef,
  SenderRef,
} from '@qodex/edge';

import type { ClawbotBridgeConfig } from './types.js';

export async function sendToQodexAndWait(args: {
  config: ClawbotBridgeConfig;
  conversation: ConversationRef;
  sender: SenderRef;
  text: string;
  workspace?: string;
}): Promise<string> {
  const client = new CoreClient(args.config.qodex.coreUrl, {
    authToken: args.config.qodex.coreAuthToken,
    requestTimeoutMs: args.config.qodex.responseTimeoutMs,
  });
  await client.connect();

  const match = {
    conversationKey: args.conversation.conversationKey,
    threadId: undefined as string | undefined,
    turnId: undefined as string | undefined,
  };

  let partialText = '';
  const outcomePromise = new Promise<string>((resolve) => {
    const onDelta = (event: ConversationDeltaEvent): void => {
      if (!matchesTurn(match, event.conversationKey, event.threadId, event.turnId)) {
        return;
      }
      partialText += event.delta;
    };
    const onCompleted = (event: ConversationCompletedEvent): void => {
      if (!matchesTurn(match, event.conversationKey, event.threadId, event.turnId)) {
        return;
      }
      cleanup();
      resolve(event.text || partialText.trim() || '[Qodex completed with an empty response]');
    };
    const onError = (event: ConversationErrorEvent): void => {
      if (!event.conversationKey) {
        return;
      }
      if (!matchesTurn(match, event.conversationKey, event.threadId, event.turnId)) {
        return;
      }
      cleanup();
      resolve(partialText.trim() ? `${partialText.trim()}\n\nQodex error: ${event.message}` : `Qodex error: ${event.message}`);
    };
    const onApproval = (event: ApprovalRequestedEvent): void => {
      if (!matchesTurn(match, event.conversationKey, event.threadId, event.turnId)) {
        return;
      }
      cleanup();
      resolve([
        partialText.trim() || undefined,
        'Qodex requires approval before continuing.',
        `approval_id=${event.approvalId}`,
        `kind=${event.kind}`,
        `summary=${event.summary}`,
        event.reason ? `reason=${event.reason}` : undefined,
      ].filter(Boolean).join('\n'));
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve(
        partialText.trim()
          ? `Qodex is still processing. Partial reply:\n\n${partialText.trim()}`
          : 'Qodex is still processing. No reply was ready before the timeout.',
      );
    }, args.config.qodex.responseTimeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeoutId);
      client.off(CoreEvents.delta, onDelta);
      client.off(CoreEvents.completed, onCompleted);
      client.off(CoreEvents.error, onError);
      client.off(CoreEvents.approvalRequested, onApproval);
    };

    client.on(CoreEvents.delta, onDelta);
    client.on(CoreEvents.completed, onCompleted);
    client.on(CoreEvents.error, onError);
    client.on(CoreEvents.approvalRequested, onApproval);
  });

  try {
    const response = await client.sendMessage({
      conversation: args.conversation,
      sender: args.sender,
      text: args.text,
      workspace: args.workspace ?? args.config.qodex.defaultWorkspace,
    });
    match.threadId = response.threadId;
    match.turnId = response.turnId;
    return await outcomePromise;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function matchesTurn(
  match: {
    conversationKey: string;
    threadId?: string;
    turnId?: string;
  },
  conversationKey: string,
  threadId?: string | null,
  turnId?: string | null,
): boolean {
  if (match.conversationKey !== conversationKey) {
    return false;
  }
  if (match.threadId && threadId && match.threadId !== threadId) {
    return false;
  }
  if (match.turnId && turnId && match.turnId !== turnId) {
    return false;
  }
  return true;
}
