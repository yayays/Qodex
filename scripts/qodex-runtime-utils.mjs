import { access, constants, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';

import { parse as parseToml } from 'toml';
import WebSocket from 'ws';

export async function loadQodexConfig(configPathArg = './qodex.toml') {
  const configPath = resolveInputPath(configPathArg);
  const raw = await readFile(configPath, 'utf8');
  return {
    configPath,
    configDir: dirname(configPath),
    config: parseToml(raw),
  };
}

export function resolveInputPath(value) {
  if (isAbsolute(value)) {
    return value;
  }
  return resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

export function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

export function normalizeHealthzHost(host) {
  if (!host || host === '0.0.0.0' || host === '::') {
    return '127.0.0.1';
  }
  return host;
}

export function buildHealthzUrl(bind) {
  const trimmed = String(bind ?? '').trim();
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

export function buildOpenCodeHealthUrl(url) {
  const parsed = new URL(url);
  parsed.pathname = '/global/health';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function backendRequested(config, backendKind) {
  if (config.backend?.kind === backendKind) {
    return true;
  }

  const channels = config.channels ?? {};
  return Object.values(channels).some((entry) => {
    if (!isRecord(entry) || entry.enabled === false) {
      return false;
    }
    const backend = entry.config?.backend;
    return isRecord(backend) && backend.kind === backendKind;
  });
}

export function enabledChannelEntries(config) {
  return Object.entries(config.channels ?? {}).filter(([, entry]) => {
    return isRecord(entry) && entry.enabled !== false;
  });
}

export function resolveChannelPluginRef(pluginRef, configDir) {
  if (typeof pluginRef !== 'string' || !pluginRef.trim()) {
    return undefined;
  }
  if (pluginRef.startsWith('.') || isAbsolute(pluginRef)) {
    return resolve(configDir, pluginRef);
  }
  return pluginRef;
}

export function resolveQQSecretFile(channelConfig, configDir) {
  const secretFile = channelConfig?.client_secret_file;
  if (typeof secretFile !== 'string' || !secretFile.trim()) {
    return undefined;
  }
  if (secretFile.startsWith('.') || isAbsolute(secretFile)) {
    return resolve(configDir, secretFile);
  }
  return resolve(configDir, secretFile);
}

export async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function checkCommand(command, args = ['--version']) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
  });
  if (result.error) {
    return {
      ok: false,
      detail: result.error.message,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      detail: (result.stderr || result.stdout || `exit ${result.status}`).trim(),
    };
  }
  return {
    ok: true,
    detail: firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr) ?? 'ok',
  };
}

export async function probeHttpOk(url, headers = undefined) {
  const response = await fetch(url, { headers });
  return {
    ok: response.ok,
    detail: `HTTP ${response.status}`,
  };
}

export async function probeWebSocket(url, headers = undefined) {
  await new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(url, {
      headers,
      handshakeTimeout: 5000,
    });

    const finish = (error) => {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    };

    ws.once('open', () => finish());
    ws.once('error', (error) => finish(error));
  });

  return {
    ok: true,
    detail: 'WebSocket connected',
  };
}

export function wsAuthHeaders(config) {
  const token = config.edge?.core_auth_token ?? config.server?.auth_token;
  if (!token) {
    return undefined;
  }
  return {
    Authorization: `Bearer ${token}`,
    'X-Qodex-Token': token,
  };
}

export function printSection(title) {
  process.stdout.write(`\n${title}\n`);
}

export function printCheck(status, label, detail) {
  const icon = status === 'ok' ? 'OK' : status === 'warn' ? 'WARN' : 'FAIL';
  process.stdout.write(`- [${icon}] ${label}${detail ? `: ${detail}` : ''}\n`);
}

export function summarizeChecks(checks) {
  const failed = checks.filter((item) => item.status === 'fail').length;
  const warned = checks.filter((item) => item.status === 'warn').length;
  return { failed, warned };
}

export function firstNonEmptyLine(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
