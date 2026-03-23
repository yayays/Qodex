import {
  backendRequested,
  buildHealthzUrl,
  buildOpenCodeHealthUrl,
  enabledChannelEntries,
  getArg,
  loadQodexConfig,
  printCheck,
  printSection,
  probeHttpOk,
  probeWebSocket,
  summarizeChecks,
  wsAuthHeaders,
} from './qodex-runtime-utils.mjs';

async function main() {
  const checks = [];
  const configArg = getArg('--config') ?? './qodex.toml';
  const { config, configPath } = await loadQodexConfig(configArg);

  process.stdout.write(`Qodex Status\nconfig=${configPath}\n`);

  printSection('Core');
  const healthzUrl = buildHealthzUrl(config.server?.bind);
  await addAsyncCheck(
    checks,
    'qodex-core healthz',
    async () => await probeHttpOk(healthzUrl),
    { successDetail: `${healthzUrl}` },
  );
  await addAsyncCheck(
    checks,
    'qodex-core WebSocket',
    async () => await probeWebSocket(config.edge?.core_url ?? 'ws://127.0.0.1:7820/ws', wsAuthHeaders(config)),
    { successDetail: String(config.edge?.core_url ?? 'ws://127.0.0.1:7820/ws') },
  );

  printSection('Backend');
  if (backendRequested(config, 'codex')) {
    await addAsyncCheck(
      checks,
      'Codex app-server',
      async () => await probeWebSocket(String(config.codex?.url ?? 'ws://127.0.0.1:8765')),
      { successDetail: String(config.codex?.url ?? 'ws://127.0.0.1:8765') },
    );
  } else {
    printCheck('ok', 'Codex app-server', 'not requested by current config');
  }

  if (backendRequested(config, 'opencode')) {
    const opencodeHealthUrl = buildOpenCodeHealthUrl(String(config.opencode?.url ?? 'http://127.0.0.1:4097'));
    await addAsyncCheck(
      checks,
      'OpenCode health',
      async () => await probeHttpOk(opencodeHealthUrl),
      { successDetail: opencodeHealthUrl },
    );
  } else {
    printCheck('ok', 'OpenCode health', 'not requested by current config');
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
    printCheck(
      'ok',
      'enabled channels',
      channels.map(([instanceId]) => instanceId).join(', '),
    );
  }

  const { failed, warned } = summarizeChecks(checks);
  printSection('Summary');
  if (failed > 0) {
    printCheck('fail', 'status summary', `${failed} failed, ${warned} warned`);
    process.exitCode = 1;
    return;
  }

  if (warned > 0) {
    printCheck('warn', 'status summary', `0 failed, ${warned} warned`);
    return;
  }

  printCheck('ok', 'status summary', 'all reachable');
}

async function addAsyncCheck(checks, label, fn, options = {}) {
  try {
    const result = await fn();
    const detail = options.successDetail ?? result.detail;
    checks.push({
      status: 'ok',
      label,
      detail,
    });
    printCheck('ok', label, detail);
  } catch (error) {
    const detail = normalizeProbeError(error, options.successDetail);
    checks.push({
      status: 'fail',
      label,
      detail,
    });
    printCheck('fail', label, detail);
  }
}

function normalizeProbeError(error, target) {
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|fetch failed|socket hang up/i.test(message)) {
    return target ? `unreachable: ${target}` : 'service unreachable';
  }
  if (/EPERM/i.test(message)) {
    return target
      ? `probe blocked or service unreachable: ${target}`
      : 'probe blocked or service unreachable';
  }
  if (/ENOTFOUND/i.test(message)) {
    return target ? `host not found: ${target}` : 'host not found';
  }
  return message;
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
