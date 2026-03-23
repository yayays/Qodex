import { dirname, isAbsolute, resolve } from 'node:path';

import {
  backendRequested,
  checkCommand,
  enabledChannelEntries,
  getArg,
  loadQodexConfig,
  pathExists,
  printCheck,
  printSection,
  resolveChannelPluginRef,
  resolveQQSecretFile,
  summarizeChecks,
} from './qodex-runtime-utils.mjs';

async function main() {
  const checks = [];
  const configArg = getArg('--config') ?? './qodex.toml';
  const { config, configPath, configDir } = await loadQodexConfig(configArg);

  process.stdout.write(`Qodex Doctor\nconfig=${configPath}\n`);

  printSection('Runtime');
  addCommandCheck(checks, 'node', 'Node.js', ['-v']);
  addCommandCheck(checks, 'npm', 'npm', ['-v']);
  addCommandCheck(checks, 'cargo', 'cargo', ['--version']);
  addCommandCheck(checks, 'rustc', 'rustc', ['--version']);

  if (backendRequested(config, 'codex')) {
    addCommandCheck(checks, 'codex', 'Codex CLI', ['--version']);
  }
  if (backendRequested(config, 'opencode')) {
    addCommandCheck(checks, 'opencode', 'OpenCode CLI', ['--version']);
  }

  printSection('Config');
  checks.push({
    status: 'ok',
    label: 'backend kind',
    detail: String(config.backend?.kind ?? 'missing'),
  });
  printCheck('ok', 'backend kind', String(config.backend?.kind ?? 'missing'));

  const defaultWorkspace = config.codex?.default_workspace;
  await addPathCheck(
    checks,
    'default workspace',
    defaultWorkspace,
    { mustBeAbsolute: true, shouldExist: true },
  );

  const allowedWorkspaces = Array.isArray(config.codex?.allowed_workspaces)
    ? config.codex.allowed_workspaces
    : [];
  if (allowedWorkspaces.length === 0) {
    checks.push({
      status: 'warn',
      label: 'allowed workspaces',
      detail: 'empty; Qodex will fall back to default_workspace only',
    });
    printCheck('warn', 'allowed workspaces', 'empty; falls back to default_workspace only');
  } else {
    for (const workspace of allowedWorkspaces) {
      await addPathCheck(checks, 'allowed workspace', workspace, {
        mustBeAbsolute: true,
        shouldExist: true,
      });
    }
  }

  const databasePath = config.database?.path;
  if (typeof databasePath === 'string' && databasePath.trim()) {
    const resolvedDatabasePath = isAbsolute(databasePath)
      ? databasePath
      : resolve(configDir, databasePath);
    const databaseParent = dirname(resolvedDatabasePath);
    const exists = await pathExists(databaseParent);
    const status = exists ? 'ok' : 'warn';
    const detail = exists
      ? `parent directory exists: ${databaseParent}`
      : `parent directory missing: ${databaseParent}`;
    checks.push({ status, label: 'database path', detail });
    printCheck(status, 'database path', detail);
  }

  printSection('Channels');
  const channels = enabledChannelEntries(config);
  if (channels.length === 0) {
    checks.push({
      status: 'warn',
      label: 'enabled channels',
      detail: 'none enabled',
    });
    printCheck('warn', 'enabled channels', 'none enabled');
  } else {
    printCheck('ok', 'enabled channels', String(channels.length));
  }

  for (const [instanceId, entry] of channels) {
    const pluginRef = resolveChannelPluginRef(entry.plugin, configDir);
    if (typeof pluginRef === 'string' && isAbsolute(pluginRef)) {
      await addPathCheck(checks, `channel ${instanceId} plugin`, pluginRef, {
        shouldExist: true,
      });
    } else {
      checks.push({
        status: 'ok',
        label: `channel ${instanceId} plugin`,
        detail: String(entry.plugin),
      });
      printCheck('ok', `channel ${instanceId} plugin`, String(entry.plugin));
    }

    const qqSecret = resolveQQSecretFile(entry.config, configDir);
    if (qqSecret) {
      const exists = await pathExists(qqSecret);
      const status = exists ? 'ok' : 'warn';
      const detail = exists ? qqSecret : `missing: ${qqSecret}`;
      checks.push({
        status,
        label: `channel ${instanceId} client_secret_file`,
        detail,
      });
      printCheck(status, `channel ${instanceId} client_secret_file`, detail);
    }
  }

  const clawbotBridge = asRecord(config.clawbot_bridge);
  if (clawbotBridge) {
    printSection('WeChat Bridge');
    const server = asRecord(clawbotBridge.server);
    const qodex = asRecord(clawbotBridge.qodex);
    const clawbot = asRecord(clawbotBridge.clawbot);

    const bridgePath = readString(server?.path);
    checks.push({
      status: bridgePath ? 'ok' : 'warn',
      label: 'clawbot bridge webhook path',
      detail: bridgePath ?? 'missing; defaults may apply',
    });
    printCheck(bridgePath ? 'ok' : 'warn', 'clawbot bridge webhook path', bridgePath ?? 'missing; defaults may apply');

    const defaultChannel = readString(clawbot?.default_channel) ?? readString(clawbot?.defaultChannel);
    checks.push({
      status: defaultChannel ? 'ok' : 'warn',
      label: 'clawbot default channel',
      detail: defaultChannel ?? 'missing; defaults to webchat',
    });
    printCheck(defaultChannel ? 'ok' : 'warn', 'clawbot default channel', defaultChannel ?? 'missing; defaults to webchat');

    const apiToken = readString(clawbot?.api_token) ?? readString(clawbot?.apiToken);
    checks.push({
      status: apiToken ? 'ok' : 'warn',
      label: 'clawbot api token',
      detail: apiToken ? 'configured' : 'missing; outbound replies may fail if your ClawBot endpoint requires auth',
    });
    printCheck(
      apiToken ? 'ok' : 'warn',
      'clawbot api token',
      apiToken ? 'configured' : 'missing; outbound replies may fail if your ClawBot endpoint requires auth',
    );

    const bridgeWorkspace =
      readString(qodex?.default_workspace) ??
      readString(qodex?.defaultWorkspace) ??
      config.codex?.default_workspace;
    if (bridgeWorkspace) {
      await addPathCheck(checks, 'clawbot bridge default workspace', bridgeWorkspace, {
        mustBeAbsolute: true,
        shouldExist: true,
      });
    }
  }

  const { failed, warned } = summarizeChecks(checks);
  printSection('Summary');
  if (failed > 0) {
    printCheck('fail', 'doctor summary', `${failed} failed, ${warned} warned`);
    process.exitCode = 1;
    return;
  }

  if (warned > 0) {
    printCheck('warn', 'doctor summary', `0 failed, ${warned} warned`);
    return;
  }

  printCheck('ok', 'doctor summary', 'all checks passed');
}

function addCommandCheck(checks, command, label, args) {
  const result = checkCommand(command, args);
  const status = result.ok ? 'ok' : 'fail';
  checks.push({
    status,
    label,
    detail: result.detail,
  });
  printCheck(status, label, result.detail);
}

async function addPathCheck(checks, label, value, options) {
  if (typeof value !== 'string' || !value.trim()) {
    checks.push({
      status: 'fail',
      label,
      detail: 'missing',
    });
    printCheck('fail', label, 'missing');
    return;
  }

  if (options.mustBeAbsolute && !isAbsolute(value)) {
    checks.push({
      status: 'fail',
      label,
      detail: `must be absolute: ${value}`,
    });
    printCheck('fail', label, `must be absolute: ${value}`);
    return;
  }

  if (options.shouldExist) {
    const exists = await pathExists(value);
    const status = exists ? 'ok' : 'warn';
    const detail = exists ? value : `missing: ${value}`;
    checks.push({ status, label, detail });
    printCheck(status, label, detail);
    return;
  }

  checks.push({
    status: 'ok',
    label,
    detail: value,
  });
  printCheck('ok', label, value);
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
