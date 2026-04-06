import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildManagedRuntimePaths,
  buildRestartNotificationPath,
  buildRestartPlan,
  createRestartNotification,
  parsePsRows,
  selectRestartTargets,
} from './qodex-restart.mjs';

test('parsePsRows reads pid and command from ps output', () => {
  const rows = parsePsRows([
    '  101   00:10 node --import tsx ./packages/qodex-edge/src/launcher.ts --config /tmp/qodex.toml',
    '  202   00:05 cargo run -p qodex-core -- --config /tmp/qodex.toml',
  ].join('\n'));

  assert.deepEqual(rows, [
    {
      pid: 101,
      etime: '00:10',
      command: 'node --import tsx ./packages/qodex-edge/src/launcher.ts --config /tmp/qodex.toml',
    },
    {
      pid: 202,
      etime: '00:05',
      command: 'cargo run -p qodex-core -- --config /tmp/qodex.toml',
    },
  ]);
});

test('selectRestartTargets limits matches to the current config and managed stack commands', () => {
  const plan = buildRestartPlan({
    configPath: '/repo/qodex.toml',
    config: {
      backend: { kind: 'opencode' },
      server: { bind: '127.0.0.1:7820' },
      opencode: { url: 'http://127.0.0.1:4097' },
      channels: {},
    },
    repoRoot: '/repo',
    configArg: './qodex.toml',
    skipAppServer: false,
  });

  const matches = selectRestartTargets([
    {
      pid: 101,
      etime: '00:10',
      command: 'node --import tsx ./packages/qodex-edge/src/launcher.ts --config /repo/qodex.toml',
    },
    {
      pid: 102,
      etime: '00:08',
      command: 'cargo run -p qodex-core -- --config /repo/qodex.toml',
    },
    {
      pid: 103,
      etime: '00:06',
      command: 'opencode serve --hostname 127.0.0.1 --port 4097',
    },
    {
      pid: 104,
      etime: '00:12',
      command: 'node --import tsx ./packages/qodex-edge/src/launcher.ts --config /other/qodex.toml',
    },
    {
      pid: 105,
      etime: '00:04',
      command: 'opencode serve --hostname 127.0.0.1 --port 5000',
    },
  ], plan);

  assert.deepEqual(
    matches.map((item) => ({ pid: item.pid, role: item.role })),
    [
      { pid: 101, role: 'launcher' },
      { pid: 102, role: 'core' },
      { pid: 103, role: 'opencode' },
    ],
  );
});

test('buildRestartPlan uses the launcher command to restart the whole stack', () => {
  const plan = buildRestartPlan({
    configPath: '/repo/qodex.toml',
    config: {
      backend: { kind: 'opencode' },
      server: { bind: '127.0.0.1:7820' },
      opencode: { url: 'http://127.0.0.1:4097' },
      channels: {},
    },
    repoRoot: '/repo',
    configArg: './qodex.toml',
    skipAppServer: false,
  });

  assert.equal(plan.start.command, 'npm');
  assert.deepEqual(plan.start.args, [
    'run',
    'host:qodex',
    '--',
    '--config',
    '/repo/qodex.toml',
  ]);
  assert.equal(plan.healthzUrl, 'http://127.0.0.1:7820/healthz');
  assert.equal(plan.opencodeHealthUrl, 'http://127.0.0.1:4097/global/health');
});

test('buildManagedRuntimePaths is stable for the same config path', () => {
  const first = buildManagedRuntimePaths('/repo/qodex.toml');
  const second = buildManagedRuntimePaths('/repo/qodex.toml');

  assert.deepEqual(first, second);
  assert.match(first.pidPath, /qodex-host-[a-f0-9]+\.pid$/);
  assert.match(first.logPath, /qodex-host-[a-f0-9]+\.log$/);
  assert.match(first.statePath, /qodex-host-[a-f0-9]+\.json$/);
});

test('selectRestartTargets prefers the recorded launcher pid as a process group target', () => {
  const plan = buildRestartPlan({
    configPath: '/repo/qodex.toml',
    config: {
      backend: { kind: 'opencode' },
      server: { bind: '127.0.0.1:7820' },
      opencode: { url: 'http://127.0.0.1:4097' },
      channels: {},
    },
    repoRoot: '/repo',
    configArg: './qodex.toml',
    skipAppServer: false,
  });

  const matches = selectRestartTargets([
    {
      pid: 101,
      etime: '00:10',
      command: 'npm run host:qodex -- --config /repo/qodex.toml',
    },
    {
      pid: 102,
      etime: '00:08',
      command: 'cargo run -p qodex-core -- --config /repo/qodex.toml',
    },
    {
      pid: 103,
      etime: '00:06',
      command: 'opencode serve --hostname 127.0.0.1 --port 4097',
    },
  ], plan, {
    pid: 101,
  });

  assert.deepEqual(
    matches.map((item) => ({ pid: item.pid, role: item.role, stopScope: item.stopScope })),
    [
      { pid: 101, role: 'launcher', stopScope: 'group' },
      { pid: 102, role: 'core', stopScope: 'process' },
      { pid: 103, role: 'opencode', stopScope: 'process' },
    ],
  );
});

test('buildRestartNotificationPath is stable for the same config path', () => {
  const first = buildRestartNotificationPath('/repo/qodex.toml');
  const second = buildRestartNotificationPath('/repo/qodex.toml');

  assert.equal(first, second);
  assert.match(first, /qodex-restart-[a-f0-9]+\.json$/);
});

test('createRestartNotification captures conversation routing fields', () => {
  assert.deepEqual(
    createRestartNotification(
      {
        conversationKey: 'qqbot:group:demo',
        platform: 'qqbot',
        scope: 'group',
        externalId: 'demo',
      },
      123,
    ),
    {
      requestedAt: 123,
      conversation: {
        conversationKey: 'qqbot:group:demo',
        platform: 'qqbot',
        scope: 'group',
        externalId: 'demo',
      },
    },
  );
});
