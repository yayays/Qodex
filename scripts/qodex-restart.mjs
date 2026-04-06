import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  backendRequested,
  buildHealthzUrl,
  buildOpenCodeHealthUrl,
  firstNonEmptyLine,
  getArg,
  loadQodexConfig,
  probeHttpOk,
  probeWebSocket,
  wsAuthHeaders,
} from './qodex-runtime-utils.mjs';

const STOP_TIMEOUT_MS = 5_000;
const KILL_TIMEOUT_MS = 2_000;
const READY_TIMEOUT_MS = 30_000;
const RESTART_NOTIFICATION_DIR = '/tmp';
const MANAGED_RUNTIME_DIR = '/tmp';

export function parsePsRows(output) {
  return String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      etime: match[2],
      command: match[3],
    }));
}

export function buildRestartPlan({
  configPath,
  config,
  repoRoot,
  configArg = './qodex.toml',
  skipAppServer = false,
}) {
  const launcherArgs = ['run', 'host:qodex', '--', '--config', configPath];
  if (skipAppServer) {
    launcherArgs.push('--skip-app-server');
  }

  const configTokens = new Set([
    `--config ${configPath}`,
    `--config=${configPath}`,
  ]);
  if (configArg) {
    configTokens.add(`--config ${configArg}`);
    configTokens.add(`--config=${configArg}`);
  }

  const managedBackends = {
    codex: !skipAppServer && backendRequested(config, 'codex'),
    opencode: !skipAppServer && backendRequested(config, 'opencode'),
  };

  return {
    repoRoot,
    configPath,
    configArg,
    skipAppServer,
    healthzUrl: buildHealthzUrl(config.server?.bind),
    codexUrl: managedBackends.codex ? String(config.codex?.url ?? 'ws://127.0.0.1:8765') : undefined,
    opencodeHealthUrl: managedBackends.opencode
      ? buildOpenCodeHealthUrl(String(config.opencode?.url ?? 'http://127.0.0.1:4097'))
      : undefined,
    opencodeServe: managedBackends.opencode
      ? parseOpenCodeServeTarget(String(config.opencode?.url ?? 'http://127.0.0.1:4097'))
      : undefined,
    matchers: {
      configTokens: [...configTokens],
    },
    start: {
      command: 'npm',
      args: launcherArgs,
    },
  };
}

export function buildRestartNotificationPath(configPath) {
  const digest = createHash('sha256')
    .update(String(configPath))
    .digest('hex')
    .slice(0, 16);
  return `${RESTART_NOTIFICATION_DIR}/qodex-restart-${digest}.json`;
}

export function buildManagedRuntimePaths(configPath) {
  const digest = createHash('sha256')
    .update(String(configPath))
    .digest('hex')
    .slice(0, 16);
  return {
    pidPath: `${MANAGED_RUNTIME_DIR}/qodex-host-${digest}.pid`,
    logPath: `${MANAGED_RUNTIME_DIR}/qodex-host-${digest}.log`,
    statePath: `${MANAGED_RUNTIME_DIR}/qodex-host-${digest}.json`,
  };
}

export async function readManagedRuntimeRecord(runtimePaths) {
  try {
    const raw = await readFile(runtimePaths.statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeManagedRuntimeRecord(runtimePaths, record) {
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(runtimePaths.statePath, content, 'utf8');
  await writeFile(runtimePaths.pidPath, `${record.pid}\n`, 'utf8');
}

export async function clearManagedRuntimeRecord(runtimePaths) {
  await Promise.all([
    rm(runtimePaths.pidPath, { force: true }),
    rm(runtimePaths.statePath, { force: true }),
  ]);
}

export function createRestartNotification(conversation, requestedAt = Date.now()) {
  return {
    requestedAt,
    conversation: {
      conversationKey: conversation.conversationKey,
      platform: conversation.platform,
      scope: conversation.scope,
      externalId: conversation.externalId,
    },
  };
}

export function selectRestartTargets(processes, plan, runtimeRecord = undefined) {
  const matches = [];

  for (const processInfo of processes) {
    const role = detectManagedRole(processInfo.command, plan);
    if (!role) {
      continue;
    }
    matches.push({ ...processInfo, role, stopScope: 'process' });
  }

  const runtimePid = runtimeRecord?.pid;
  if (Number.isInteger(runtimePid) && runtimePid > 0) {
    const recorded = processes.find((processInfo) => processInfo.pid === runtimePid);
    if (recorded) {
      const role = detectManagedRole(recorded.command, plan);
      if (role === 'launcher') {
        const deduped = matches.filter((item) => item.pid !== recorded.pid);
        deduped.unshift({ ...recorded, role, stopScope: 'group' });
        matches.splice(0, matches.length, ...deduped);
      }
    }
  }

  const roleOrder = ['launcher', 'core', 'codex', 'opencode'];
  matches.sort((left, right) => {
    return roleOrder.indexOf(left.role) - roleOrder.indexOf(right.role);
  });
  return matches;
}

function detectManagedRole(command, plan) {
  if (isLauncherCommand(command, plan)) {
    return 'launcher';
  }
  if (isCoreCommand(command, plan)) {
    return 'core';
  }
  if (isCodexCommand(command, plan)) {
    return 'codex';
  }
  if (isOpenCodeCommand(command, plan)) {
    return 'opencode';
  }
  return undefined;
}

function isLauncherCommand(command, plan) {
  if (
    !containsAny(command, [
      'packages/qodex-edge/src/launcher.ts',
      'dist/launcher.js',
      'qodex-host',
      'npm run host:qodex',
    ])
  ) {
    return false;
  }
  return containsAny(command, plan.matchers.configTokens);
}

function isCoreCommand(command, plan) {
  if (!containsAny(command, ['qodex-core'])) {
    return false;
  }
  return containsAny(command, plan.matchers.configTokens);
}

function isCodexCommand(command, plan) {
  if (!plan.codexUrl) {
    return false;
  }
  return containsAny(command, ['codex app-server']) && containsAny(command, [plan.codexUrl]);
}

function isOpenCodeCommand(command, plan) {
  if (!plan.opencodeServe) {
    return false;
  }
  return containsAny(command, ['opencode serve'])
    && containsAny(command, [`--hostname ${plan.opencodeServe.hostname}`])
    && containsAny(command, [`--port ${String(plan.opencodeServe.port)}`]);
}

function containsAny(command, needles) {
  return needles.some((needle) => command.includes(needle));
}

function parseOpenCodeServeTarget(url) {
  const parsed = new URL(url);
  return {
    hostname: parsed.hostname === '0.0.0.0' || parsed.hostname === '::' ? '127.0.0.1' : parsed.hostname,
    port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
  };
}

export function listProcesses() {
  const result = spawnSync('ps', ['-axo', 'pid,etime,command'], {
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(firstNonEmptyLine(result.stderr) ?? `ps exited with status ${result.status}`);
  }
  return parsePsRows(result.stdout);
}

async function stopTargets(targets) {
  for (const target of targets) {
    process.stdout.write(`- stopping ${target.role} pid=${target.pid}\n`);
    const terminate = target.stopScope === 'group' ? terminateProcessGroup : terminateProcess;
    const exited = await terminate(target.pid, 'SIGTERM', STOP_TIMEOUT_MS);
    if (exited) {
      continue;
    }
    process.stdout.write(`- escalating ${target.role} pid=${target.pid} to SIGKILL\n`);
    await terminate(target.pid, 'SIGKILL', KILL_TIMEOUT_MS);
  }
}

async function terminateProcess(pid, signal, timeoutMs) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (isMissingProcessError(error)) {
      return true;
    }
    throw error;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(200);
  }
  return !isProcessAlive(pid);
}

export async function terminateProcessGroup(pid, signal, timeoutMs) {
  const groupPid = -Math.abs(pid);
  try {
    process.kill(groupPid, signal);
  } catch (error) {
    if (isMissingProcessError(error)) {
      return true;
    }
    throw error;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(200);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingProcessError(error) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH';
}

export async function startStack(plan, runtimePaths = undefined) {
  const logFd = runtimePaths ? openSync(runtimePaths.logPath, 'a') : 'ignore';
  const child = spawn(plan.start.command, plan.start.args, {
    cwd: plan.repoRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      INIT_CWD: plan.repoRoot,
    },
  });
  if (typeof logFd === 'number') {
    closeSync(logFd);
  }
  if (runtimePaths) {
    await writeManagedRuntimeRecord(runtimePaths, {
      pid: child.pid,
      command: `${plan.start.command} ${plan.start.args.join(' ')}`,
      configPath: plan.configPath,
      repoRoot: plan.repoRoot,
      logPath: runtimePaths.logPath,
      startedAt: new Date().toISOString(),
    });
  }
  child.unref();
  return child.pid;
}

export async function waitForReady(plan, config) {
  await waitForProbe('qodex-core healthz', async () => {
    const response = await probeHttpOk(plan.healthzUrl);
    if (!response.ok) {
      throw new Error(response.detail);
    }
  });

  if (plan.codexUrl) {
    await waitForProbe('Codex app-server', async () => {
      await probeWebSocket(plan.codexUrl);
    });
  }

  if (plan.opencodeHealthUrl) {
    await waitForProbe('OpenCode health', async () => {
      const response = await probeHttpOk(plan.opencodeHealthUrl);
      if (!response.ok) {
        throw new Error(response.detail);
      }
    });
  }

  await waitForProbe('qodex-core WebSocket', async () => {
    await probeWebSocket(String(config.edge?.core_url ?? 'ws://127.0.0.1:7820/ws'), wsAuthHeaders(config));
  });
}

async function waitForProbe(label, probe) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    try {
      await probe();
      process.stdout.write(`- ready: ${label}\n`);
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw new Error(
    `${label} did not become ready within ${READY_TIMEOUT_MS}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function writeRestartNotification(configPath, conversation) {
  if (!conversation) {
    return;
  }

  const notificationPath = buildRestartNotificationPath(configPath);
  await writeFile(
    notificationPath,
    `${JSON.stringify(createRestartNotification(conversation), null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`- queued restart notification: ${notificationPath}\n`);
}

async function main() {
  const configArg = getArg('--config') ?? './qodex.toml';
  const skipAppServer = process.argv.includes('--skip-app-server');
  const notifyConversation = getRestartNotificationConversationFromArgs();
  const { config, configPath } = await loadQodexConfig(configArg);
  const runtimePaths = buildManagedRuntimePaths(configPath);
  const runtimeRecord = await readManagedRuntimeRecord(runtimePaths);
  const repoRoot = resolve(process.env.INIT_CWD ?? process.cwd());
  const plan = buildRestartPlan({
    configPath,
    config,
    repoRoot,
    configArg,
    skipAppServer,
  });

  process.stdout.write(`Qodex Restart\nconfig=${configPath}\n`);

  const targets = selectRestartTargets(listProcesses(), plan, runtimeRecord);
  if (targets.length === 0) {
    throw new Error(`no managed Qodex stack found for config ${configPath}`);
  }

  process.stdout.write(`- found ${targets.length} managed process(es)\n`);
  await writeRestartNotification(configPath, notifyConversation);
  await stopTargets(targets);
  await clearManagedRuntimeRecord(runtimePaths);

  process.stdout.write(`- starting: ${plan.start.command} ${plan.start.args.join(' ')}\n`);
  let startedPid;
  try {
    startedPid = await startStack(plan, runtimePaths);
    process.stdout.write(`- background pid: ${startedPid}\n`);
    process.stdout.write(`- log: ${runtimePaths.logPath}\n`);
    await waitForReady(plan, config);
  } catch (error) {
    if (startedPid) {
      await terminateProcessGroup(startedPid, 'SIGKILL', KILL_TIMEOUT_MS);
    }
    await clearManagedRuntimeRecord(runtimePaths);
    throw error;
  }

  process.stdout.write('Qodex restart complete\n');
}

function getRestartNotificationConversationFromArgs() {
  const conversationKey = getArg('--notify-conversation-key');
  const platform = getArg('--notify-platform');
  const scope = getArg('--notify-scope');
  const externalId = getArg('--notify-external-id');

  if (!conversationKey || !platform || !scope || !externalId) {
    return undefined;
  }

  return {
    conversationKey,
    platform,
    scope,
    externalId,
  };
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  await main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
