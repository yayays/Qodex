import test from 'node:test';
import assert from 'node:assert/strict';

import { readChannel, renderQuickStartConfig } from './qodex-quick-start.mjs';

test('readChannel accepts builtin wechat quick-start mode', () => {
  assert.equal(readChannel('wechat'), 'wechat');
});

test('readChannel accepts qq quick-start mode', () => {
  assert.equal(readChannel('qq'), 'qq');
});

test('renderQuickStartConfig writes builtin wechat adapter config for wechat mode', () => {
  const config = renderQuickStartConfig({
    workspace: '/tmp/qodex',
    backendKind: 'codex',
    channel: 'wechat',
    values: {},
    repoRoot: process.cwd(),
  });

  assert.match(config, /\[channels\.wechat\]/);
  assert.match(config, /plugin = "builtin:wechat-openclaw-compat"/);
  assert.match(config, /adapter_module = "builtin:tencent-wechat"/);
  assert.doesNotMatch(config, /\[clawbot_bridge\.server\]/);
});

test('readChannel rejects quick-start modes other than qq and wechat', () => {
  assert.throws(() => readChannel('console'), /unsupported channel: console/);
  assert.throws(() => readChannel('wechat-clawbot'), /unsupported channel: wechat-clawbot/);
});
