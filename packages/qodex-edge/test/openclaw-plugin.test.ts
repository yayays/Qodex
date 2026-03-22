import assert from 'node:assert/strict';
import test from 'node:test';

import { qodexOpenClawPlugin } from '../src/openclaw-plugin.js';

interface RegisteredCommand {
  name: string;
  handler: (context: Record<string, unknown>) => Promise<{ text: string }>;
}

test('openclaw plugin normalizes wechat channel to webchat and roomId to group conversation', async () => {
  const commands = registerCommands();
  const qodex = commands.find((command) => command.name === 'qodex');
  assert.ok(qodex);

  const result = await qodex.handler({
    channel: 'wechat',
    roomId: 'room-42',
    senderId: 'wx-user-1',
  });

  assert.match(result.text, /conversation=webchat:group:room-42/);
});

test('openclaw plugin falls back to pluginConfig.defaultPlatform when channel is absent', async () => {
  const commands = registerCommands();
  const qodex = commands.find((command) => command.name === 'qodex');
  assert.ok(qodex);

  const result = await qodex.handler({
    senderId: 'wx-user-2',
    pluginConfig: {
      defaultPlatform: 'webchat',
    },
  });

  assert.match(result.text, /conversation=webchat:c2c:wx-user-2/);
});

function registerCommands(): RegisteredCommand[] {
  const commands: RegisteredCommand[] = [];
  qodexOpenClawPlugin.register({
    registerCommand(command) {
      commands.push(command as RegisteredCommand);
    },
  });
  return commands;
}
