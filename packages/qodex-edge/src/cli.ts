import readline from 'node:readline/promises';
import { isAbsolute, resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';

import { QodexChannelHost } from './channel-host.js';
import { consoleChannelExtension } from './channels/console.js';
import { loadConfig } from './config.js';
import { CoreClient } from './coreClient.js';
import { createLogger } from './logger.js';
import { ConversationRef } from './protocol.js';
import { ChannelScope } from './plugin-sdk.js';
import { QodexEdgeRuntime } from './runtime.js';

async function main(): Promise<void> {
  const configPath = resolveInputPath(getArg('--config') ?? './qodex.toml');
  const config = await loadConfig(configPath);
  const logger = createLogger(config.logging.node);
  const core = new CoreClient(config.edge.coreUrl, {
    authToken: config.edge.coreAuthToken,
    requestTimeoutMs: config.edge.requestTimeoutMs,
  });
  const runtime = new QodexEdgeRuntime(core, logger, config);
  await runtime.start();
  const host = new QodexChannelHost(runtime, logger, config);
  runtime.attachHost(host);
  await host.registerExtension(consoleChannelExtension, 'builtin:console');
  await host.startConfiguredChannels();
  await runtime.recoverPendingDeliveries();
  const conversation = parseConversation(
    getArg('--conversation') ?? 'qqbot:group:demo',
  );
  const channelId = getArg('--channel') ?? 'console';
  const senderId = getArg('--sender') ?? 'local-user';
  const senderName = getArg('--name') ?? 'Local User';
  const oneShotText = getArg('--text');
  const headless = hasFlag('--headless');

  if (oneShotText) {
    await host.dispatchInbound({
      channelId,
      platform: conversation.platform,
      scope: toChannelScope(conversation.scope),
      targetId: conversation.externalId,
      senderId,
      senderName,
      text: oneShotText,
    });
    await core.close();
    return;
  }

  if (headless) {
    logger.info(
      {
        channelId,
        registeredChannels: host.listRegisteredChannels().map((channel) => channel.id),
        activeChannels: host.listActiveChannels(),
      },
      'Qodex host running in headless mode',
    );
    await new Promise<void>(() => {});
  }

  logger.info(
    {
      conversationKey: conversation.conversationKey,
      channelId,
      registeredChannels: host.listRegisteredChannels().map((channel) => channel.id),
      activeChannels: host.listActiveChannels(),
    },
    'Qodex demo CLI ready',
  );
  output.write(
    'Commands: /help, /bind /path, /new, /status, /status+, /running, /approve <id>, /reject <id>\n',
  );
  output.write('Type a normal message to send it to the configured backend. Ctrl+C to exit.\n\n');

  const rl = readline.createInterface({ input, output });
  while (true) {
    const line = await rl.question('> ');
    await host.dispatchInbound({
      channelId,
      platform: conversation.platform,
      scope: toChannelScope(conversation.scope),
      targetId: conversation.externalId,
      senderId,
      senderName,
      text: line,
    });
  }
}

function parseConversation(value: string): ConversationRef {
  const [platform, scope, ...rest] = value.split(':');
  const externalId = rest.join(':');
  if (!platform || !scope || !externalId) {
    throw new Error(`invalid conversation key: ${value}`);
  }
  return {
    conversationKey: value,
    platform,
    scope,
    externalId,
  };
}

function toChannelScope(value: string): ChannelScope {
  if (value === 'c2c' || value === 'group' || value === 'channel') {
    return value;
  }
  throw new Error(`invalid channel scope: ${value}`);
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
