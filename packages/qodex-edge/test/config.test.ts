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
  assert.equal(config.codex.approvalPolicy, 'on-request');
  assert.equal(config.codex.sandbox, 'workspace-write');
  assert.equal(config.codex.experimentalApi, false);
  assert.equal(config.codex.serviceName, 'Qodex');
  assert.equal(config.codex.defaultWorkspace, '/tmp/backend-workspace');
  assert.deepEqual(config.codex.allowedWorkspaces, []);
  assert.equal(config.codex.requestTimeoutMs, 30_000);
  assert.equal(config.opencode.url, 'http://127.0.0.1:4096');
  assert.equal(config.opencode.model, 'o3');
  assert.equal(config.opencode.modelProvider, 'openrouter');
  assert.equal(config.opencode.approvalPolicy, 'on-request');
  assert.equal(config.opencode.sandbox, 'workspace-write');
  assert.equal(config.opencode.serviceName, 'Qodex');
  assert.equal(config.opencode.requestTimeoutMs, 30_000);
  assert.equal(config.edge.requestTimeoutMs, 30_000);
  assert.equal(config.edge.coreAuthToken, undefined);
  assert.equal((config.channels[0]?.config.backend as { kind?: string } | undefined)?.kind, 'opencode');
});

test('loadConfig parses aligned codex/opencode/edge fields from config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qodex-edge-config-fields-'));
  const configPath = join(dir, 'qodex.toml');
  await writeFile(
    configPath,
    [
      '[server]',
      'bind = "127.0.0.1:9000"',
      'auth_token = "shared-token"',
      '',
      '[codex]',
      'default_workspace = "/tmp/workspace"',
      'allowed_workspaces = ["/tmp/workspace", "/tmp/other"]',
      'approval_policy = "never"',
      'sandbox = "read-only"',
      'experimental_api = true',
      'service_name = "Qodex Edge"',
      'request_timeout_ms = 45000',
      '',
      '[opencode]',
      'approval_policy = "untrusted"',
      'sandbox = "danger-full-access"',
      'service_name = "Qodex OpenCode"',
      'request_timeout_ms = 47000',
      '',
      '[edge]',
      'core_auth_token = "edge-token"',
      'request_timeout_ms = 41000',
      'stream_flush_ms = 900',
    ].join('\n'),
    'utf8',
  );

  const config = await loadConfig(configPath);

  assert.equal(config.server.authToken, 'shared-token');
  assert.equal(config.codex.approvalPolicy, 'never');
  assert.equal(config.codex.sandbox, 'read-only');
  assert.equal(config.codex.experimentalApi, true);
  assert.equal(config.codex.serviceName, 'Qodex Edge');
  assert.deepEqual(config.codex.allowedWorkspaces, ['/tmp/workspace', '/tmp/other']);
  assert.equal(config.codex.requestTimeoutMs, 45_000);
  assert.equal(config.opencode.approvalPolicy, 'untrusted');
  assert.equal(config.opencode.sandbox, 'danger-full-access');
  assert.equal(config.opencode.serviceName, 'Qodex OpenCode');
  assert.equal(config.opencode.requestTimeoutMs, 47_000);
  assert.equal(config.edge.coreAuthToken, 'edge-token');
  assert.equal(config.edge.requestTimeoutMs, 41_000);
  assert.equal(config.edge.streamFlushMs, 900);
});
