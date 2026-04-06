import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import WebSocket from 'ws';

import { QodexChannelHost } from './channel-host.js';
import { consoleChannelExtension } from './channels/console.js';
import { QodexConfig, loadConfig } from './config.js';
import { CoreClient } from './coreClient.js';
import { createLogger } from './logger.js';
import { QodexEdgeRuntime } from './runtime.js';
import type { ConversationRef } from './core-protocol.js';

interface ManagedChild {
  label: string;
  process: ChildProcess;
}

interface RestartNotification {
  requestedAt: number;
  conversation: ConversationRef;
}

const RESTART_NOTIFICATION_DIR = '/tmp';
const RESTART_NOTIFICATION_TTL_MS = 10 * 60_000;

async function main(): Promise<void> {
  const configPath = resolveInputPath(getArg('--config') ?? './qodex.toml');
  const skipAppServer = hasFlag('--skip-app-server');
  const config = await loadConfig(configPath);
  const logger = createLogger(config.logging.node);
  const children: ManagedChild[] = [];
  let shuttingDown = false;
  let core: CoreClient | undefined;
  let host: QodexChannelHost | undefined;

  const shutdown = async (reason?: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (reason) {
      logger.info({ reason }, 'shutting down Qodex host');
    }

    try {
      await host?.stop();
    } catch (error) {
      logger.warn({ error }, 'failed to stop channel host cleanly');
    }

    try {
      await core?.close();
    } catch (error) {
      logger.warn({ error }, 'failed to close edge core client cleanly');
    }

    for (const child of [...children].reverse()) {
      await stopChild(child, logger);
    }

    process.exitCode = exitCode;
  };

  const fail = async (error: unknown): Promise<void> => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error }, 'Qodex host failed');
    await shutdown(message, 1);
  };

  process.on('SIGINT', () => {
    void shutdown('received SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('received SIGTERM');
  });

  try {
    if (shouldStartManagedCodexAppServer(config, skipAppServer)) {
      const codexChild = startChild(
        'codex',
        'codex',
        ['app-server', '--listen', config.codex.url],
        { cwd: process.cwd() },
      );
      children.push(codexChild);
      await waitForWebSocket(config.codex.url, 30_000);
      logger.info({ url: config.codex.url }, 'codex app-server is ready');
    } else if (!backendRequested(config, 'codex')) {
      logger.info(
        { backend: config.backend.kind },
        'skipping managed codex app-server because the configured backend does not use it',
      );
    }

    if (shouldStartManagedOpenCodeServer(config, skipAppServer)) {
      const { hostname, port } = parseOpenCodeListenOptions(config.opencode.url);
      const opencodeChild = startChild(
        'opencode',
        'opencode',
        ['serve', '--hostname', hostname, '--port', String(port)],
        { cwd: process.cwd() },
      );
      children.push(opencodeChild);
      await waitForHttpOk(buildOpenCodeHealthUrl(config.opencode.url), 30_000, 'OpenCode server');
      await waitForOpenCodeEventStream(config.opencode.url, 30_000);
      logger.info({ url: config.opencode.url }, 'OpenCode server is ready');
    } else if (!backendRequested(config, 'opencode')) {
      logger.info(
        { backend: config.backend.kind },
        'skipping managed OpenCode server because the configured backend does not use it',
      );
    }

    const coreChild = startChild(
      'core',
      'cargo',
      ['run', '-p', 'qodex-core', '--', '--config', configPath],
      { cwd: process.cwd() },
    );
    children.push(coreChild);
    await waitForHealthz(config.server.bind, 30_000);
    logger.info({ bind: config.server.bind }, 'qodex-core is ready');

    core = new CoreClient(config.edge.coreUrl, {
      authToken: config.edge.coreAuthToken,
      requestTimeoutMs: config.edge.requestTimeoutMs,
    });
    const runtime = new QodexEdgeRuntime(core, logger, config);
    await runtime.start();

    host = new QodexChannelHost(runtime, logger, config);
    runtime.attachHost({
      resolveSinkForConversation: (conversation) => host?.resolveSinkForConversation(conversation),
      listConversationChannels: (conversation) => host?.listConversationChannels(conversation) ?? [],
      getRestartInfo: () => ({
        configPath,
        skipAppServer,
      }),
      requestRestart: async (conversation) => {
        spawnDetachedRestartHelper(configPath, skipAppServer, conversation);
      },
    });
    await host.registerExtension(consoleChannelExtension, 'builtin:console');
    await host.startConfiguredChannels();
    await runtime.recoverPendingDeliveries();
    await deliverPendingRestartNotification(host, configPath, skipAppServer, logger);

    logger.info(
      {
        activeChannels: host.listActiveChannels(),
        registeredChannels: host.listRegisteredChannels().map((channel) => channel.id),
      },
      'Qodex host is running',
    );

    for (const child of children) {
      child.process.on('exit', (code, signal) => {
        if (shuttingDown) {
          return;
        }
        const detail = `${child.label} exited code=${String(code)} signal=${String(signal)}`;
        void fail(new Error(detail));
      });
    }

    await new Promise<void>(() => {});
  } catch (error) {
    await fail(error);
    return;
  }
}

function spawnDetachedRestartHelper(
  configPath: string,
  skipAppServer: boolean,
  conversation?: ConversationRef,
): void {
  const helperArgs = [resolve(process.cwd(), 'scripts/qodex-restart.mjs'), '--config', configPath];
  if (skipAppServer) {
    helperArgs.push('--skip-app-server');
  }
  if (conversation) {
    helperArgs.push(
      '--notify-conversation-key',
      conversation.conversationKey,
      '--notify-platform',
      conversation.platform,
      '--notify-scope',
      conversation.scope,
      '--notify-external-id',
      conversation.externalId,
    );
  }

  const child = spawn(process.execPath, helperArgs, {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      INIT_CWD: process.cwd(),
    },
  });
  child.unref();
}

async function deliverPendingRestartNotification(
  host: QodexChannelHost,
  configPath: string,
  skipAppServer: boolean,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const notificationPath = buildRestartNotificationPath(configPath);
  const notification = await readRestartNotification(notificationPath, logger);
  if (!notification) {
    return;
  }

  const ageMs = Date.now() - notification.requestedAt;
  if (ageMs > RESTART_NOTIFICATION_TTL_MS) {
    await clearRestartNotification(notificationPath, logger);
    return;
  }

  const sink = host.resolveSinkForConversation(notification.conversation);
  if (!sink) {
    logger.warn({ configPath, notificationPath }, 'restart completed but no sink was available for the requesting conversation');
    await clearRestartNotification(notificationPath, logger);
    return;
  }

  try {
    await sink.sendText({
      conversationKey: notification.conversation.conversationKey,
      kind: 'system',
      text: [
        'Qodex restart complete.',
        `config=${configPath}`,
        `appServers=${skipAppServer ? 'skipped' : 'managed'}`,
      ].join('\n'),
    });
    await clearRestartNotification(notificationPath, logger);
  } catch (error) {
    logger.warn({ error, notificationPath }, 'failed to deliver restart completion notification');
    await clearRestartNotification(notificationPath, logger);
  }
}

function buildRestartNotificationPath(configPath: string): string {
  const digest = createHash('sha256')
    .update(configPath)
    .digest('hex')
    .slice(0, 16);
  return `${RESTART_NOTIFICATION_DIR}/qodex-restart-${digest}.json`;
}

async function readRestartNotification(
  notificationPath: string,
  logger: ReturnType<typeof createLogger>,
): Promise<RestartNotification | undefined> {
  try {
    const raw = await readFile(notificationPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RestartNotification>;
    if (
      typeof parsed.requestedAt !== 'number'
      || !parsed.conversation
      || typeof parsed.conversation.conversationKey !== 'string'
      || typeof parsed.conversation.platform !== 'string'
      || typeof parsed.conversation.scope !== 'string'
      || typeof parsed.conversation.externalId !== 'string'
    ) {
      return undefined;
    }
    return parsed as RestartNotification;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    logger.warn({ error, notificationPath }, 'failed to read pending restart notification');
    return undefined;
  }
}

async function clearRestartNotification(
  notificationPath: string,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    await rm(notificationPath, { force: true });
  } catch (error) {
    logger.warn({ error, notificationPath }, 'failed to clear restart notification');
  }
}

function startChild(
  label: string,
  command: string,
  args: string[],
  options: { cwd: string },
): ManagedChild {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (child.stdout) {
    pipeChildStream(label, child.stdout, process.stdout);
  }
  if (child.stderr) {
    pipeChildStream(label, child.stderr, process.stderr);
  }

  child.on('error', (error) => {
    const output = process.stderr;
    output.write(`[${label}] failed to start: ${error.message}\n`);
  });

  return {
    label,
    process: child,
  };
}

async function stopChild(
  child: ManagedChild,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  if (child.process.killed || child.process.exitCode !== null) {
    return;
  }

  child.process.kill('SIGTERM');
  const stopped = await waitForChildExit(child.process, 5_000);
  if (stopped) {
    return;
  }

  logger.warn({ child: child.label }, 'child did not stop after SIGTERM, sending SIGKILL');
  child.process.kill('SIGKILL');
  await waitForChildExit(child.process, 2_000);
}

function pipeChildStream(
  label: string,
  stream: NodeJS.ReadableStream,
  output: NodeJS.WriteStream,
): void {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      output.write(`[${label}] ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (pending) {
      output.write(`[${label}] ${pending}\n`);
    }
  });
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForWebSocket(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await attemptWebSocket(url);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await sleep(500);
    }
  }

  throw new Error(
    `timed out waiting for codex app-server at ${url}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

function shouldStartManagedCodexAppServer(
  config: QodexConfig,
  skipAppServer: boolean,
): boolean {
  return !skipAppServer && backendRequested(config, 'codex');
}

function shouldStartManagedOpenCodeServer(
  config: QodexConfig,
  skipAppServer: boolean,
): boolean {
  return !skipAppServer && backendRequested(config, 'opencode');
}

function backendRequested(
  config: QodexConfig,
  backendKind: QodexConfig['backend']['kind'],
): boolean {
  if (config.backend.kind === backendKind) {
    return true;
  }

  return config.channels.some((entry) => {
    if (!entry.enabled) {
      return false;
    }
    const backend = entry.config?.backend;
    if (backend && typeof backend === 'object' && !Array.isArray(backend)) {
      return (backend as { kind?: unknown }).kind === backendKind;
    }
    return false;
  });
}

async function attemptWebSocket(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const finish = (error?: Error): void => {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    ws.once('open', () => finish());
    ws.once('error', (error) => finish(error));
  });
}

async function waitForHealthz(bind: string, timeoutMs: number): Promise<void> {
  const healthzUrl = buildHealthzUrl(bind);
  await waitForHttpOk(healthzUrl, timeoutMs, 'qodex-core healthz');
}

async function waitForOpenCodeEventStream(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await attemptOpenCodeEventStream(url);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await sleep(500);
    }
  }

  throw new Error(
    `timed out waiting for OpenCode event stream at ${url}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

async function waitForHttpOk(url: string, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await sleep(500);
  }

  throw new Error(
    `timed out waiting for ${label} at ${url}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

function buildHealthzUrl(bind: string): string {
  const trimmed = bind.trim();
  if (!trimmed) {
    return 'http://127.0.0.1:7820/healthz';
  }

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    const host = trimmed.slice(1, end);
    const port = trimmed.slice(end + 2);
    return `http://${normalizeHealthzHost(host)}:${port}/healthz`;
  }

  const separator = trimmed.lastIndexOf(':');
  if (separator === -1) {
    return `http://${normalizeHealthzHost(trimmed)}/healthz`;
  }

  const host = trimmed.slice(0, separator);
  const port = trimmed.slice(separator + 1);
  return `http://${normalizeHealthzHost(host)}:${port}/healthz`;
}

function normalizeHealthzHost(host: string): string {
  if (!host || host === '0.0.0.0' || host === '::') {
    return '127.0.0.1';
  }
  return host;
}

function parseOpenCodeListenOptions(url: string): { hostname: string; port: number } {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`OpenCode url must use http/https: ${url}`);
  }

  return {
    hostname: normalizeHealthzHost(parsed.hostname),
    port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
  };
}

async function attemptOpenCodeEventStream(baseUrl: string): Promise<void> {
  const targets = [buildOpenCodeEventUrl(baseUrl, '/event'), buildOpenCodeEventUrl(baseUrl, '/global/event')];
  let lastError: Error | undefined;

  for (const target of targets) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, 5_000);

      try {
        const response = await fetch(target, {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`event stream returned ${response.status}`);
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('text/event-stream')) {
          throw new Error(`event stream returned unexpected content-type: ${contentType || 'unknown'}`);
        }

        await response.body?.cancel();
      } finally {
        clearTimeout(timer);
      }

      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error('OpenCode event stream probe failed');
}

function buildOpenCodeHealthUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/global/health';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function buildOpenCodeEventUrl(url: string, path: string): string {
  const parsed = new URL(url);
  parsed.pathname = path;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function resolveInputPath(value: string): string {
  if (isAbsolute(value)) {
    return value;
  }
  return resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
