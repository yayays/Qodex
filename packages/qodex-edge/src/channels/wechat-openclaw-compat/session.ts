import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ChannelGatewayContext } from '../../plugin-contract.js';
import { loadWechatCompatAdapter } from './loader.js';
import { toChannelInboundMessage } from './translate.js';
import type {
  WechatCompatAdapter,
  WechatCompatConnectionEvent,
  WechatCompatQrCodeEvent,
} from './types.js';

export interface ActiveWechatCompatSession {
  adapter: WechatCompatAdapter;
  platform: string;
}

interface ResolvedWechatCompatConfig {
  adapterModule: string;
  platform: string;
  loginArtifactDir?: string;
  qrFilename?: string;
}

const activeSessions = new Map<string, ActiveWechatCompatSession>();

export function getWechatCompatSession(
  instanceId: string | undefined,
): ActiveWechatCompatSession | undefined {
  if (!instanceId) {
    return undefined;
  }
  return activeSessions.get(instanceId);
}

export async function startWechatCompatSession(
  context: ChannelGatewayContext,
): Promise<void> {
  const resolved = resolveWechatCompatConfig(context);
  const createAdapter = await loadWechatCompatAdapter(
    resolved.adapterModule,
    context.account.configDir,
  );

  const updateStatus = (patch: Record<string, unknown>) => {
    context.setStatus({
      ...context.getStatus(),
      accountId: context.account.accountId,
      ...patch,
    });
  };

  const adapter = await createAdapter({
    config: context.account.config,
    configDir: context.account.configDir,
    instanceId: context.account.instanceId,
    accountId: context.account.accountId,
    log: context.log,
    abortSignal: context.abortSignal,
    host: {
      emitQrCode: (event) => {
        void persistQrArtifact(resolved, context.account.configDir, event).then((artifactPath) => {
          updateStatus(buildQrStatus(event, artifactPath));
        });
      },
      setConnection: (event) => {
        updateStatus(buildConnectionStatus(event));
      },
      receiveMessage: async (event) => {
        await context.runtime.dispatchInbound(
          toChannelInboundMessage({
            channelId: 'wechat-openclaw-compat',
            platform: resolved.platform,
            accountId: context.account.accountId,
            event,
          }),
        );
      },
    },
  });

  activeSessions.set(context.account.instanceId, {
    adapter,
    platform: resolved.platform,
  });
  updateStatus({
    connected: false,
    loginState: 'starting',
  });

  try {
    await adapter.start();
  } catch (error) {
    activeSessions.delete(context.account.instanceId);
    updateStatus({
      connected: false,
      loginState: 'error',
      lastError: formatError(error),
    });
    throw error;
  }
}

export async function stopWechatCompatSession(
  context: ChannelGatewayContext,
): Promise<void> {
  const session = activeSessions.get(context.account.instanceId);
  activeSessions.delete(context.account.instanceId);
  if (!session) {
    return;
  }
  await session.adapter.stop?.();
  context.setStatus({
    ...context.getStatus(),
    connected: false,
    loginState: 'stopped',
  });
}

function resolveWechatCompatConfig(
  context: ChannelGatewayContext,
): ResolvedWechatCompatConfig {
  const adapterModule = readString(context.account.config.adapter_module);
  if (!adapterModule) {
    throw new Error(
      `wechat compat channel "${context.account.instanceId}" requires config.adapter_module`,
    );
  }

  return {
    adapterModule,
    platform: readString(context.account.config.default_platform) ?? 'webchat',
    loginArtifactDir: readString(context.account.config.login_artifact_dir),
    qrFilename: readString(context.account.config.qr_filename),
  };
}

function buildQrStatus(
  event: WechatCompatQrCodeEvent,
  artifactPath: string | undefined,
): Record<string, unknown> {
  return {
    connected: false,
    loginState: 'waitingForScan',
    qrValue: event.value,
    qrFormat: event.format ?? 'text',
    qrExpiresAt: event.expiresAt,
    qrNote: event.note,
    qrPath: artifactPath,
  };
}

function buildConnectionStatus(
  event: WechatCompatConnectionEvent,
): Record<string, unknown> {
  return {
    connected: event.connected,
    loginState: event.loginState ?? (event.connected ? 'connected' : 'disconnected'),
    accountId: event.accountId,
    lastError: event.lastError,
    lastLoginAt: event.connected ? Date.now() : undefined,
  };
}

async function persistQrArtifact(
  config: ResolvedWechatCompatConfig,
  configDir: string,
  event: WechatCompatQrCodeEvent,
): Promise<string | undefined> {
  if (!config.loginArtifactDir) {
    return undefined;
  }

  const targetDir = resolve(configDir, config.loginArtifactDir);
  const fileName = config.qrFilename ?? 'wechat-qr.txt';
  const filePath = join(targetDir, fileName);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, event.value, 'utf8');
  return filePath;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
