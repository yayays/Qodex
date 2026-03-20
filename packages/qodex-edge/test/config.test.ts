import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

test('loadConfig reads backend kind, model defaults, and shared default workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qodex-edge-config-'));
  const configPath = join(dir, 'qodex.toml');
  await writeFile(
    configPath,
    [
      '[backend]',
      'kind = "opencode"',
      '',
      '[codex]',
      'url = "ws://127.0.0.1:9988"',
      'model = "gpt-5.4"',
      'model_provider = "openai"',
      'default_workspace = "/tmp/backend-workspace"',
      '',
      '[opencode]',
      'url = "http://127.0.0.1:4096"',
      'model = "o3"',
      'model_provider = "openrouter"',
      '',
      '[channels.qq]',
      'enabled = true',
      'plugin = "builtin:console"',
      '',
      '[channels.qq.config.backend]',
      'kind = "opencode"',
    ].join('\n'),
    'utf8',
  );

  const config = await loadConfig(configPath);

  assert.equal(config.backend.kind, 'opencode');
  assert.equal(config.backend.defaultWorkspace, '/tmp/backend-workspace');
  assert.equal(config.codex.url, 'ws://127.0.0.1:9988');
  assert.equal(config.codex.model, 'gpt-5.4');
  assert.equal(config.codex.modelProvider, 'openai');
  assert.equal(config.codex.defaultWorkspace, '/tmp/backend-workspace');
  assert.equal(config.opencode.url, 'http://127.0.0.1:4096');
  assert.equal(config.opencode.model, 'o3');
  assert.equal(config.opencode.modelProvider, 'openrouter');
  assert.equal((config.channels[0]?.config.backend as { kind?: string } | undefined)?.kind, 'opencode');
});
