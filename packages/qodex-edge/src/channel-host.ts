import { ChannelEntryConfig, QodexConfig } from './config.js';
import { QodexLogger } from './logger.js';
import {
  ConversationRef,
} from './core-protocol.js';
import {
  CodexRequestOverrides,
  OutboundSink,
  PlatformMessage,
  StreamUpdateMessage,
} from './platform-protocol.js';
import {
  ChannelInboundMessage,
  ChannelPlugin,
  ChannelRuntimeStatus,
  ChannelSendTextParams,
  QodexPluginExtension,
  buildChannelAddress,
} from './plugin-contract.js';
import { QodexEdgeRuntime } from './runtime.js';
import { loadPluginExtension } from './plugin-loader.js';
import {
  createHostGatewayContext,
  createHostPluginApi,
  createHostRuntimeBridge,
  validatePluginExtensionCompatibility,
} from './plugin-host-adapter.js';

interface ActiveChannelInstance {
  entry: ChannelEntryConfig;
  plugin: ChannelPlugin;
  status: ChannelRuntimeStatus;
  abortController: AbortController;
}

export class QodexChannelHost {
  private readonly registeredChannels = new Map<string, ChannelPlugin>();
  private readonly extensionChannels = new Map<string, string[]>();
  private readonly activeInstances = new Map<string, ActiveChannelInstance>();
  private readonly runtimeApi;
  private readonly pluginApi;

  constructor(
    private readonly runtime: QodexEdgeRuntime,
    private readonly logger: QodexLogger,
    private readonly config: QodexConfig,
  ) {
    this.runtimeApi = createHostRuntimeBridge({
      logger: this.logger,
      config: this.config,
      dispatchInbound: async (message) => {
        await this.dispatchInbound(message);
      },
      getChannelEntry: (channelId) => this.getChannelEntry(channelId),
    });

    this.pluginApi = createHostPluginApi({
      logger: this.logger,
      config: this.config,
      dispatchInbound: async (message) => {
        await this.dispatchInbound(message);
      },
      getChannelEntry: (channelId) => this.getChannelEntry(channelId),
      registerChannel: (plugin) => {
        this.registerChannel(plugin);
      },
    });
  }

  async registerExtension(
    extension: QodexPluginExtension,
    source = extension.id,
  ): Promise<void> {
    validatePluginExtensionCompatibility(extension);
    const before = new Set(this.registeredChannels.keys());
    await extension.register(this.pluginApi);
    const newChannelIds = [...this.registeredChannels.keys()].filter((id) => !before.has(id));
    if (!this.extensionChannels.has(source)) {
      this.extensionChannels.set(source, newChannelIds);
    }
  }

  registerChannel(plugin: ChannelPlugin): void {
    const existing = this.registeredChannels.get(plugin.id);
    if (existing && existing !== plugin) {
      this.logger.warn({ channelId: plugin.id }, 'replacing previously registered channel plugin');
    }
    this.registeredChannels.set(plugin.id, plugin);
  }

  async startConfiguredChannels(): Promise<void> {
    for (const entry of this.config.channels) {
      if (!entry.enabled) {
        continue;
      }
      await this.startChannelInstance(entry);
    }
  }

  async startChannelInstance(entry: ChannelEntryConfig): Promise<void> {
    const pluginRef = entry.plugin;
    if (!this.extensionChannels.has(pluginRef)) {
      const extension = await loadPluginExtension(pluginRef);
      await this.registerExtension(extension, pluginRef);
    }

    const plugin = this.resolvePluginForEntry(entry, pluginRef);
    const instance: ActiveChannelInstance = {
      entry,
      plugin,
      status: {},
      abortController: new AbortController(),
    };
    this.activeInstances.set(entry.instanceId, instance);

    if (plugin.gateway?.startAccount) {
      await plugin.gateway.startAccount(this.createGatewayContext(instance));
    }
  }

  async stop(): Promise<void> {
    const instances = [...this.activeInstances.values()].reverse();
    for (const instance of instances) {
      instance.abortController.abort();
      if (instance.plugin.gateway?.stopAccount) {
        await instance.plugin.gateway.stopAccount(this.createGatewayContext(instance));
      }
    }
    this.activeInstances.clear();
  }

  listRegisteredChannels(): ChannelPlugin[] {
    return [...this.registeredChannels.values()];
  }

  listActiveChannels(): Array<{
    instanceId: string;
    channelId: string;
    accountId?: string;
    status: ChannelRuntimeStatus;
  }> {
    return [...this.activeInstances.values()].map((instance) => ({
      instanceId: instance.entry.instanceId,
      channelId: instance.plugin.id,
      accountId: instance.entry.accountId,
      status: instance.status,
    }));
  }

  async dispatchInbound(message: ChannelInboundMessage): Promise<void> {
    const instance = this.resolveActiveInstance(message.channelId);
    const plugin = instance?.plugin ?? this.registeredChannels.get(message.channelId);

    if (!plugin) {
      throw new Error(`channel plugin "${message.channelId}" is not registered`);
    }

    const platform = message.platform ?? plugin.id;
    const conversation = {
      conversationKey: buildChannelAddress(platform, message.scope, message.targetId),
      platform,
      scope: message.scope,
      externalId: message.targetId,
    };
    const target = this.normalizeTarget(plugin, message, platform);
    const sink = this.createSink(plugin, instance, {
      target,
      accountId: message.accountId ?? instance?.entry.accountId,
      replyToId: message.replyToId,
    });

    const platformMessage: PlatformMessage = {
      conversation,
      sender: {
        senderId: message.senderId,
        displayName: message.senderName,
      },
      text: message.text,
      images: message.images,
      files: message.files,
      workspace: message.workspace,
      backendKind: resolveBackendKindOverride(instance?.entry),
      codex: resolveCodexOverrides(instance?.entry),
    };

    await this.runtime.handleIncoming(platformMessage, sink);
  }

  getChannelEntry(channelId: string): ChannelEntryConfig | undefined {
    const instance = this.resolveActiveInstance(channelId);
    if (instance) {
      return instance.entry;
    }

    return this.config.channels.find(
      (entry) => entry.instanceId === channelId || entry.channelId === channelId,
    );
  }

  resolveSinkForConversation(conversation: ConversationRef): OutboundSink | undefined {
    const instance = this.resolveInstanceForConversation(conversation);
    if (!instance) {
      return undefined;
    }

    const target = this.buildTargetForConversation(instance, conversation);
    return this.createSink(instance.plugin, instance, {
      target,
      accountId: instance.entry.accountId,
    });
  }

  listConversationChannels(
    conversation?: ConversationRef | null,
  ): Array<{
    instanceId: string;
    channelId: string;
    accountId?: string;
    status: ChannelRuntimeStatus;
  }> {
    const instances = conversation
      ? this.resolveInstancesForConversation(conversation)
      : [...this.activeInstances.values()];
    return instances.map((instance) => ({
      instanceId: instance.entry.instanceId,
      channelId: instance.plugin.id,
      accountId: instance.entry.accountId,
      status: instance.status,
    }));
  }

  private resolvePluginForEntry(
    entry: ChannelEntryConfig,
    pluginRef: string,
  ): ChannelPlugin {
    if (entry.channelId) {
      const byId = this.registeredChannels.get(entry.channelId);
      if (!byId) {
        throw new Error(
          `channel "${entry.channelId}" from plugin "${pluginRef}" is not registered`,
        );
      }
      return byId;
    }

    const channelIds = this.extensionChannels.get(pluginRef) ?? [];
    if (channelIds.length === 1) {
      const plugin = this.registeredChannels.get(channelIds[0]);
      if (plugin) {
        return plugin;
      }
    }

    const byInstanceName = this.registeredChannels.get(entry.instanceId);
    if (byInstanceName) {
      return byInstanceName;
    }

    throw new Error(
      `cannot resolve channel for entry "${entry.instanceId}"; set channels.${entry.instanceId}.channel_id explicitly`,
    );
  }

  private resolveActiveInstance(channelId: string): ActiveChannelInstance | undefined {
    const instances = [...this.activeInstances.values()];
    const byInstanceId = instances.find((instance) => instance.entry.instanceId === channelId);
    if (byInstanceId) {
      return byInstanceId;
    }

    const byChannelId = instances.filter((instance) => instance.entry.channelId === channelId);
    if (byChannelId.length === 1) {
      return byChannelId[0];
    }
    if (byChannelId.length > 1) {
      throw new Error(
        `channel "${channelId}" is ambiguous across ${byChannelId.length} active instances; use a concrete instance_id`,
      );
    }

    const byPluginId = instances.filter((instance) => instance.plugin.id === channelId);
    if (byPluginId.length > 1) {
      throw new Error(
        `channel "${channelId}" is ambiguous across ${byPluginId.length} active instances; use a concrete instance_id`,
      );
    }

    return byPluginId[0];
  }

  private normalizeTarget(
    plugin: ChannelPlugin,
    message: ChannelInboundMessage,
    platform: string,
  ): string {
    const rawTarget =
      message.to ?? buildChannelAddress(platform, message.scope, message.targetId);
    return plugin.messaging?.normalizeTarget?.(rawTarget) ?? rawTarget;
  }

  private buildTargetForConversation(
    instance: ActiveChannelInstance,
    conversation: ConversationRef,
  ): string {
    const rawTarget =
      instance.plugin.messaging?.buildTargetFromConversation?.(conversation)
      ?? buildChannelAddress(
        conversation.platform,
        conversation.scope as 'c2c' | 'group' | 'channel',
        conversation.externalId,
      );
    return instance.plugin.messaging?.normalizeTarget?.(rawTarget) ?? rawTarget;
  }

  private resolveInstanceForConversation(
    conversation: ConversationRef,
  ): ActiveChannelInstance | undefined {
    const matches = this.resolveInstancesForConversation(conversation);
    if (matches.length === 0) {
      return undefined;
    }
    if (matches.length > 1) {
      throw new Error(
        `conversation "${conversation.conversationKey}" matches ${matches.length} channel instances`,
      );
    }
    return matches[0];
  }

  private resolveInstancesForConversation(
    conversation: ConversationRef,
  ): ActiveChannelInstance[] {
    return [...this.activeInstances.values()].filter((instance) =>
      this.instanceSupportsConversation(instance, conversation),
    );
  }

  private instanceSupportsConversation(
    instance: ActiveChannelInstance,
    conversation: ConversationRef,
  ): boolean {
    const platforms =
      instance.plugin.messaging?.conversationPlatforms?.(instance.entry)
      ?? [instance.plugin.id];
    return platforms.includes(conversation.platform);
  }

  private createSink(
    plugin: ChannelPlugin,
    instance: ActiveChannelInstance | undefined,
    base: {
      target: string;
      accountId?: string;
      replyToId?: string;
    },
  ): OutboundSink {
    const sendViaChannel = async (payload: ChannelSendTextParams): Promise<void> => {
      await plugin.outbound.sendText(payload);
    };

    return {
      showAcceptedAck: plugin.id === 'console',
      sendText: async (message) => {
        await sendViaChannel({
          to: base.target,
          text: message.text,
          kind: message.kind,
          accountId: base.accountId,
          replyToId: base.replyToId,
          entry: instance?.entry,
        });
      },
      sendStreamUpdate: plugin.outbound.sendStreamUpdate
        ? async (message: StreamUpdateMessage) => {
            await plugin.outbound.sendStreamUpdate?.({
              to: base.target,
              text: message.text,
              kind: message.kind,
              accountId: base.accountId,
              replyToId: base.replyToId,
              turnId: message.turnId,
              entry: instance?.entry,
            });
          }
        : undefined,
    };
  }

  private createGatewayContext(instance: ActiveChannelInstance) {
    return createHostGatewayContext({
      entry: instance.entry,
      abortSignal: instance.abortController.signal,
      config: this.config,
      logger: this.logger.child({
        channel: instance.plugin.id,
        instanceId: instance.entry.instanceId,
      }),
      runtime: this.runtimeApi,
      getStatus: () => instance.status,
      setStatus: (status: ChannelRuntimeStatus) => {
        const { message, fields } = summarizeChannelStatus(status);
        this.logger.info(
          {
            instanceId: instance.entry.instanceId,
            channelId: instance.plugin.id,
            accountId: instance.entry.accountId,
            ...fields,
          },
          message,
        );
        instance.status = status;
      },
    });
  }
}

function summarizeChannelStatus(
  status: ChannelRuntimeStatus,
): { message: string; fields: Record<string, unknown> } {
  const connected = readBoolean(status.connected);
  const mode = readString(status.mode);
  const loginState = readString(status.loginState);
  const lastError = readString(status.lastError);
  const connection = compactRecord({
    connected,
    ...(mode ? { mode } : {}),
    ...(loginState ? { loginState } : {}),
    ...(lastError ? { lastError } : {}),
  });
  const gateway = compactRecord({
    url: readString(status.gatewayUrl),
    intent: readNumber(status.gatewayIntent),
  });
  const session = compactRecord({
    appId: readString(status.appId),
    sessionId: readString(status.sessionId),
    botUserId: readString(status.botUserId),
    readyAt: readNumber(status.readyAt),
    resumedAt: readNumber(status.resumedAt),
    lastHeartbeatAckAt: readNumber(status.lastHeartbeatAckAt),
    lastSeq: readNumber(status.lastSeq),
  });
  const allowFrom = readStringArray(status.allowFrom);
  const filters = allowFrom
    ? compactRecord({
        allowFromCount: allowFrom.length,
        ...(allowFrom.length > 0 ? { allowFromPreview: allowFrom.slice(0, 5) } : {}),
      })
    : undefined;
  const details = compactRecord(
    Object.fromEntries(
      Object.entries(status).filter(([key]) => !KNOWN_STATUS_KEYS.has(key)),
    ),
  );
  const summaryParts = [
    connected === true ? 'connected' : connected === false ? 'disconnected' : undefined,
    mode ? `via ${mode}` : undefined,
    loginState ? `login=${loginState}` : undefined,
    lastError ? `error=${lastError}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    message:
      summaryParts.length > 0
        ? `channel status updated: ${summaryParts.join(' ')}`
        : 'channel status updated',
    fields: compactRecord({
      ...(Object.keys(connection).length > 0 ? { connection } : {}),
      ...(Object.keys(gateway).length > 0 ? { gateway } : {}),
      ...(Object.keys(session).length > 0 ? { session } : {}),
      ...(filters && Object.keys(filters).length > 0 ? { filters } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    }),
  };
}

function resolveCodexOverrides(
  entry: ChannelEntryConfig | undefined,
): CodexRequestOverrides | undefined {
  const codex = entry?.config?.codex;
  if (!isRecord(codex)) {
    return undefined;
  }

  const model = readString(codex.model);
  const modelProvider = readString(codex.modelProvider) ?? readString(codex.model_provider);
  if (!model && !modelProvider) {
    return undefined;
  }

  return {
    model,
    modelProvider,
  };
}

function resolveBackendKindOverride(
  entry: ChannelEntryConfig | undefined,
): 'codex' | 'opencode' | undefined {
  const backend = entry?.config?.backend;
  if (!isRecord(backend)) {
    return undefined;
  }

  return backend.kind === 'codex' || backend.kind === 'opencode' ? backend.kind : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compactRecord<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

const KNOWN_STATUS_KEYS = new Set([
  'connected',
  'loginState',
  'lastError',
  'mode',
  'gatewayUrl',
  'gatewayIntent',
  'appId',
  'sessionId',
  'botUserId',
  'readyAt',
  'resumedAt',
  'lastHeartbeatAckAt',
  'lastSeq',
  'allowFrom',
]);
