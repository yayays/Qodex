import type { CoreClient } from '../coreClient.js';
import type { QodexConfig } from '../config.js';
import type { QodexLogger } from '../logger.js';
import type {
  ApprovalDecision,
  FileInput,
  OutboundSink,
  PlatformMessage,
  SavedFileResult,
} from '../protocol.js';
import { parseApprovalIntent } from './approvals.js';
import { handleRuntimeCommand } from './commands.js';
import { resolveQuickReply } from './utils.js';
import type { RuntimeSessionState } from './state.js';
import type { RuntimeHostBridge } from '../runtime.js';

export interface RuntimeInboundDeps {
  core: CoreClient;
  logger: QodexLogger;
  config: QodexConfig;
  host?: RuntimeHostBridge;
  sessionState: RuntimeSessionState;
  resolveBackendKind(message: PlatformMessage): QodexConfig['backend']['kind'];
  resolveApproval(
    conversationKey: string,
    approvalToken: string | undefined,
    decision: ApprovalDecision,
    sink: OutboundSink,
  ): Promise<void>;
}

export class RuntimeInboundHandler {
  constructor(private readonly deps: RuntimeInboundDeps) {}

  async handleIncoming(message: PlatformMessage, sink: OutboundSink): Promise<void> {
    this.deps.sessionState.rememberSink(message.conversation.conversationKey, sink);
    this.deps.sessionState.pruneIdleState();
    const trimmed = message.text.trim();
    const conversationKey = message.conversation.conversationKey;

    try {
      const pendingImage = this.deps.sessionState.getPendingImage(conversationKey);
      if (pendingImage && !(message.images?.length && !trimmed)) {
        if (looksLikePendingImageInstruction(trimmed)) {
          this.deps.sessionState.clearPendingImage(conversationKey);
          await this.forwardPendingImageMessage(message, pendingImage.savedFiles, sink);
          return;
        }
        this.deps.sessionState.clearPendingImage(conversationKey);
      }

      if (shouldInterceptImageOnlyMessage(message)) {
        await this.handleImageOnlyMessage(message, sink);
        return;
      }

      if (trimmed.startsWith('/')) {
        await handleRuntimeCommand(
          {
            core: this.deps.core,
            config: this.deps.config,
            host: this.deps.host,
            sessionState: this.deps.sessionState,
            resolveBackendKind: (platformMessage) => this.deps.resolveBackendKind(platformMessage),
            resolveApproval: (key, approvalToken, decision, outboundSink) =>
              this.deps.resolveApproval(key, approvalToken, decision, outboundSink),
          },
          message,
          sink,
        );
        return;
      }

      const approvalIntent = parseApprovalIntent(trimmed);
      if (approvalIntent) {
        await this.deps.resolveApproval(
          conversationKey,
          approvalIntent.approvalToken,
          approvalIntent.decision,
          sink,
        );
        return;
      }

      const quickReply = resolveQuickReply(trimmed);
      if (quickReply) {
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: quickReply,
        });
        return;
      }

      const response = await this.deps.core.sendMessage({
        conversation: message.conversation,
        sender: message.sender,
        text: message.text,
        images: message.images,
        files: message.files,
        workspace: message.workspace,
        backendKind: this.deps.resolveBackendKind(message),
        model: message.codex?.model,
        modelProvider: message.codex?.modelProvider,
      });
      await reportSavedFiles(conversationKey, response.savedFiles ?? [], sink);
      this.deps.sessionState.registerActiveTurn(
        message.conversation.conversationKey,
        response.turnId,
      );

      if (sink.showAcceptedAck) {
        await sink.sendText({
          conversationKey,
          kind: 'system',
          text: `Qodex accepted message. thread=${response.threadId} turn=${response.turnId}`,
        });
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.deps.logger.error(
        {
          conversationKey,
          error,
        },
        'failed to handle inbound message',
      );
      await sink.sendText({
        conversationKey,
        kind: 'error',
        text: `Qodex error: ${messageText}`,
      });
    }
  }

  private async handleImageOnlyMessage(message: PlatformMessage, sink: OutboundSink): Promise<void> {
    const conversationKey = message.conversation.conversationKey;
    const response = await this.deps.core.saveFiles({
      conversation: message.conversation,
      files: imageInputsToFiles(message.images ?? []),
      workspace: message.workspace,
      backendKind: this.deps.resolveBackendKind(message),
    });
    const savedImages = response.savedFiles.filter(
      (file) => file.status === 'saved' && typeof file.savedPath === 'string',
    );
    if (savedImages.length === 0) {
      const failures = response.savedFiles.map((file) => {
        const label = file.filename ?? file.url ?? '(unknown image)';
        return `Failed to save image ${label}: ${file.error ?? 'unknown error'}`;
      });
      await sink.sendText({
        conversationKey,
        kind: 'error',
        text: failures.join('\n'),
      });
      return;
    }

    this.deps.sessionState.setPendingImage(conversationKey, savedImages);
    const pathLines = savedImages
      .map((file) => `- ${file.savedPath}`)
      .join('\n');
    const failureLines = response.savedFiles
      .filter((file) => file.status === 'failed')
      .map((file) => {
        const label = file.filename ?? file.url ?? '(unknown image)';
        return `Failed to save image ${label}: ${file.error ?? 'unknown error'}`;
      });
    const lines = [
      '图片已保存。请回复怎么处理这张图片，我会再发送给 Codex/OpenCode。',
      pathLines,
      '例如：`是，识别这个图片`',
      ...failureLines,
    ];
    await sink.sendText({
      conversationKey,
      kind: 'system',
      text: lines.join('\n'),
    });
  }

  private async forwardPendingImageMessage(
    message: PlatformMessage,
    savedFiles: SavedFileResult[],
    sink: OutboundSink,
  ): Promise<void> {
    const conversationKey = message.conversation.conversationKey;
    const pathLines = savedFiles
      .map((file, index) => `image_${index + 1}_path: ${file.savedPath}`)
      .join('\n');
    const combinedText = `${message.text.trim()}\n\nSaved image path(s):\n${pathLines}`;
    const response = await this.deps.core.sendMessage({
      conversation: message.conversation,
      sender: message.sender,
      text: combinedText,
      images: undefined,
      files: message.files,
      workspace: message.workspace,
      backendKind: this.deps.resolveBackendKind(message),
      model: message.codex?.model,
      modelProvider: message.codex?.modelProvider,
    });
    await reportSavedFiles(conversationKey, response.savedFiles ?? [], sink);
    this.deps.sessionState.registerActiveTurn(conversationKey, response.turnId);
  }
}

function shouldInterceptImageOnlyMessage(message: PlatformMessage): boolean {
  return message.text.trim().length === 0
    && (message.images?.length ?? 0) > 0
    && (message.files?.length ?? 0) === 0;
}

function imageInputsToFiles(images: NonNullable<PlatformMessage['images']>): FileInput[] {
  return images.map((image) => ({
    source: 'remote',
    url: image.url,
    ...(image.filename ? { filename: image.filename } : {}),
    ...(image.mimeType ? { mimeType: image.mimeType } : {}),
    ...(typeof image.size === 'number' ? { size: image.size } : {}),
  }));
}

function looksLikePendingImageInstruction(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return /^(是|好|行|可以|帮我|请|麻烦|识别|分析|查看|看|描述|解释|总结|提取|翻译|ocr|OCR)/.test(trimmed)
    || /图|图片|截图|image|photo/i.test(trimmed);
}

function formatSavedFileLines(savedFiles: SavedFileResult[]): string[] {
  return savedFiles.map((file) => {
    if (file.status === 'saved') {
      const target = file.savedPath ?? file.filename ?? '(unknown path)';
      const name = file.filename ? `${file.filename}: ` : '';
      return `Saved file ${name}${target}`;
    }
    const name = file.filename ?? file.url ?? '(unknown file)';
    return `Failed to save file ${name}: ${file.error ?? 'unknown error'}`;
  });
}

async function reportSavedFiles(
  conversationKey: string,
  savedFiles: SavedFileResult[],
  sink: OutboundSink,
): Promise<void> {
  if (savedFiles.length === 0) {
    return;
  }
  await sink.sendText({
    conversationKey,
    kind: 'system',
    text: formatSavedFileLines(savedFiles).join('\n'),
  });
}
