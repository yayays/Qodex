import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { getArg, pathExists, printCheck, printSection, resolveInputPath } from './qodex-runtime-utils.mjs';

async function main() {
  const answers = await collectQuickStartAnswers();
  const configPath = answers.configPath;
  const workspace = answers.workspace;
  const backendKind = answers.backendKind;
  const channel = answers.channel;
  const force = hasFlag('--force');
  const noStart = hasFlag('--no-start');
  const skipAppServer = hasFlag('--skip-app-server');

  process.stdout.write(
    `Qodex Quick Start\nconfig=${configPath}\nworkspace=${workspace}\nbackend=${backendKind}\nchannel=${channel}\n`,
  );

  if (!(await pathExists(workspace))) {
    throw new Error(`workspace does not exist: ${workspace}`);
  }

  const configExists = await pathExists(configPath);
  const dataDir = resolve(dirname(configPath), './data');
  await mkdir(dataDir, { recursive: true });

  printSection('Config');
  if (configExists && !force) {
    printCheck('warn', 'config file', `already exists, keeping current file: ${configPath}`);
  } else {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      renderQuickStartConfig({
        workspace,
        backendKind,
        channel,
        values: answers.values,
        repoRoot: process.cwd(),
      }),
      'utf8',
    );
    printCheck('ok', 'config file', `${configExists ? 'rewrote' : 'created'} ${configPath}`);
  }

  printSection('Preflight');
  const doctor = spawnSync(process.execPath, ['./scripts/qodex-doctor.mjs', '--config', configPath], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (doctor.status !== 0) {
    process.exitCode = doctor.status ?? 1;
    return;
  }

  if (noStart) {
    printSection('Next Step');
    printCheck('ok', 'start command', buildPrimaryStartCommand(configPath, skipAppServer));
    if (channel === 'wechat') {
      printCheck('ok', 'wechat bridge', buildWechatBridgeCommand(configPath));
    }
    return;
  }

  printSection('Launch');
  printCheck('ok', 'starting', buildPrimaryStartCommand(configPath, skipAppServer));
  if (channel === 'wechat') {
    printCheck('ok', 'starting bridge', buildWechatBridgeCommand(configPath));
  }
  await startQuickStack({ configPath, skipAppServer, channel });
}

async function collectQuickStartAnswers() {
  const interactive = Boolean(input.isTTY && output.isTTY);
  const configPath = resolveInputPath(getArg('--config') ?? './qodex.toml');
  const workspace = resolveWorkspace(
    await promptIfMissing('--workspace', process.cwd(), 'Workspace path', interactive),
  );
  const backendKind = readBackendKind(
    await promptChoiceIfMissing(
      '--backend',
      'codex',
      ['codex', 'opencode'],
      'Backend kind',
      interactive,
    ),
  );
  const channel = readChannel(
    await promptChannelIfMissing(
      '--channel',
      'console',
      interactive,
    ),
  );

  return {
    configPath,
    workspace,
    backendKind,
    channel,
    values: await collectChannelValues(channel, interactive),
  };
}

async function collectChannelValues(channel, interactive) {
  if (channel === 'qq') {
    const appId = await promptIfMissing('--app-id', undefined, 'QQ App ID', interactive);
    const clientSecretFile = resolveOptionalPath(
      await promptIfMissing(
        '--client-secret-file',
        undefined,
        'QQ client secret file path',
        interactive,
      ),
    );
    return { appId, clientSecretFile };
  }

  if (channel === 'wechat') {
    return {
      clawbotApiBaseUrl: await promptIfMissing(
        '--clawbot-api-base-url',
        'https://www.clawbot.world',
        'ClawBot API base URL',
        interactive,
      ),
      clawbotApiToken: await promptIfMissing(
        '--clawbot-api-token',
        undefined,
        'ClawBot API token (optional)',
        interactive,
        { required: false },
      ),
      clawbotMessagePath: await promptIfMissing(
        '--clawbot-message-path',
        '/api/v1/messages',
        'ClawBot message path',
        interactive,
      ),
      clawbotDefaultChannel: await promptIfMissing(
        '--clawbot-default-channel',
        'webchat',
        'ClawBot default channel',
        interactive,
      ),
      bridgeHost: await promptIfMissing(
        '--bridge-host',
        '127.0.0.1',
        'Bridge listen host',
        interactive,
      ),
      bridgePort: readInteger(
        await promptIfMissing('--bridge-port', '7840', 'Bridge listen port', interactive),
      ) ?? 7840,
      bridgePath: await promptIfMissing(
        '--bridge-path',
        '/webhooks/clawbot',
        'Bridge webhook path',
        interactive,
      ),
      signatureHeader: await promptIfMissing(
        '--signature-header',
        undefined,
        'Webhook signature header (optional)',
        interactive,
        { required: false },
      ),
      signatureToken: await promptIfMissing(
        '--signature-token',
        undefined,
        'Webhook signature token (optional)',
        interactive,
        { required: false },
      ),
    };
  }

  return {};
}

function renderQuickStartConfig({ workspace, backendKind, channel, values, repoRoot }) {
  const parts = [
    '# Generated by `npm run quick:start`.',
    '# This is a minimal quick-start configuration. For advanced plugin and multi-instance',
    '# layouts, copy from qodex.example.toml and extend this file.',
    '',
    '[server]',
    'bind = "127.0.0.1:7820"',
    '',
    '[database]',
    'path = "./data/qodex.db"',
    'store_message_content = false',
    'message_retention_days = 7',
    'approval_retention_days = 3',
    'redact_resolved_approval_payloads = true',
    '',
    '[backend]',
    `kind = "${backendKind}"`,
    '',
    '[codex]',
    'url = "ws://127.0.0.1:8765"',
    'model = "gpt-5.4"',
    'approval_policy = "on-request"',
    'sandbox = "workspace-write"',
    'experimental_api = false',
    'service_name = "Qodex"',
    `default_workspace = ${quoteTomlString(workspace)}`,
    `allowed_workspaces = [${quoteTomlString(workspace)}]`,
    'request_timeout_ms = 30000',
    '',
    '[opencode]',
    'url = "http://127.0.0.1:4097"',
    'approval_policy = "on-request"',
    'sandbox = "workspace-write"',
    'service_name = "Qodex"',
    'request_timeout_ms = 30000',
    '',
    '[edge]',
    'core_url = "ws://127.0.0.1:7820/ws"',
    'request_timeout_ms = 30000',
    'stream_flush_ms = 1200',
    '',
    '[logging]',
    'rust = "info,qodex_core=debug"',
    'node = "info"',
    '',
  ];

  parts.push(...renderChannelSection(channel, values, repoRoot));

  if (channel === 'wechat') {
    parts.push(...renderWechatBridgeSection(workspace, values));
  }

  return parts.join('\n');
}

function renderChannelSection(channel, values, repoRoot) {
  if (channel === 'console') {
    return [
      '[channels.console]',
      'enabled = true',
      'plugin = "builtin:console"',
      '',
      '[channels.console.config]',
      '',
    ];
  }

  if (channel === 'qq') {
    const qqPluginPath = resolve(repoRoot, './packages/qodex-channel-qqbot/src/index.ts');
    return [
      '[channels.qq]',
      'enabled = true',
      `plugin = ${quoteTomlString(qqPluginPath)}`,
      'channel_id = "qqbot"',
      'account_id = "main-account"',
      '',
      '[channels.qq.config]',
      `app_id = ${quoteTomlString(values.appId)}`,
      `client_secret_file = ${quoteTomlString(values.clientSecretFile)}`,
      'markdown_support = false',
      'request_timeout_ms = 15000',
      '',
    ];
  }

  return [
    '[channels.console]',
    'enabled = true',
    'plugin = "builtin:console"',
    '',
    '[channels.console.config]',
    '',
  ];
}

function renderWechatBridgeSection(workspace, values) {
  const lines = [
    '[clawbot_bridge.server]',
    `host = ${quoteTomlString(values.bridgeHost)}`,
    `port = ${values.bridgePort}`,
    `path = ${quoteTomlString(values.bridgePath)}`,
  ];

  if (values.signatureHeader) {
    lines.push(`signature_header = ${quoteTomlString(values.signatureHeader)}`);
  }
  if (values.signatureToken) {
    lines.push(`signature_token = ${quoteTomlString(values.signatureToken)}`);
  }

  lines.push(
    '',
    '[clawbot_bridge.qodex]',
    'core_url = "ws://127.0.0.1:7820/ws"',
    `default_workspace = ${quoteTomlString(workspace)}`,
    'response_timeout_ms = 90000',
    '',
    '[clawbot_bridge.clawbot]',
    `api_base_url = ${quoteTomlString(values.clawbotApiBaseUrl)}`,
  );

  if (values.clawbotApiToken) {
    lines.push(`api_token = ${quoteTomlString(values.clawbotApiToken)}`);
  }

  lines.push(
    `message_path = ${quoteTomlString(values.clawbotMessagePath)}`,
    `default_channel = ${quoteTomlString(values.clawbotDefaultChannel)}`,
    'request_timeout_ms = 15000',
    'max_retries = 2',
    'retry_backoff_ms = 500',
    '',
  );

  return lines;
}

function quoteTomlString(value) {
  return JSON.stringify(value);
}

function resolveWorkspace(value) {
  if (isAbsolute(value)) {
    return value;
  }
  return resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

function resolveOptionalPath(value) {
  if (!value) {
    return value;
  }
  if (isAbsolute(value)) {
    return value;
  }
  return resolve(process.env.INIT_CWD ?? process.cwd(), value);
}

function readBackendKind(value) {
  if (value === 'codex' || value === 'opencode') {
    return value;
  }
  throw new Error(`unsupported backend kind: ${value}`);
}

function readChannel(value) {
  if (value === 'console' || value === 'qq' || value === 'wechat') {
    return value;
  }
  throw new Error(`unsupported channel: ${value}`);
}

function readInteger(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function buildPrimaryStartCommand(configPath, skipAppServer) {
  const parts = ['npm run host:qodex -- --config', shellEscape(configPath)];
  if (skipAppServer) {
    parts.push('--skip-app-server');
  }
  return parts.join(' ');
}

function buildWechatBridgeCommand(configPath) {
  return [
    'node --import tsx',
    './packages/qodex-clawbot-bridge/src/cli.ts',
    '--config',
    shellEscape(configPath),
  ].join(' ');
}

function shellEscape(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

async function startQuickStack({ configPath, skipAppServer, channel }) {
  const children = [];
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    for (const child of [...children].reverse()) {
      if (!child.killed && child.exitCode === null) {
        child.kill('SIGTERM');
      }
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const host = spawnManaged(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'run',
    'host:qodex',
    '--',
    '--config',
    configPath,
    ...(skipAppServer ? ['--skip-app-server'] : []),
  ]);
  children.push(host);

  if (channel === 'wechat') {
    const bridge = spawnManaged(process.execPath, [
      '--import',
      'tsx',
      './packages/qodex-clawbot-bridge/src/cli.ts',
      '--config',
      configPath,
    ]);
    children.push(bridge);
  }

  await new Promise((resolvePromise) => {
    for (const child of children) {
      child.on('exit', (code) => {
        if (!shuttingDown && code && code !== 0) {
          process.exitCode = code;
        }
        shutdown();
        resolvePromise();
      });
      child.on('error', () => {
        process.exitCode = 1;
        shutdown();
        resolvePromise();
      });
    }
  });
}

function spawnManaged(command, args) {
  return spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
}

async function promptIfMissing(flag, fallback, label, interactive, options = { required: true }) {
  const existing = getArg(flag);
  if (existing) {
    return existing;
  }

  if (!interactive) {
    if (fallback !== undefined) {
      return fallback;
    }
    if (options.required === false) {
      return undefined;
    }
    throw new Error(`${label} is required; pass ${flag} in non-interactive mode`);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const suffix = fallback !== undefined ? ` [${fallback}]` : options.required === false ? ' [optional]' : '';
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    if (answer) {
      return answer;
    }
    if (fallback !== undefined) {
      return fallback;
    }
    if (options.required === false) {
      return undefined;
    }
    throw new Error(`${label} is required`);
  } finally {
    rl.close();
  }
}

async function promptChoiceIfMissing(flag, fallback, choices, label, interactive) {
  const existing = getArg(flag);
  if (existing) {
    return existing;
  }

  if (!interactive) {
    return fallback;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (
      await rl.question(`${label} (${choices.join('/')}) [${fallback}]: `)
    ).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function promptChannelIfMissing(flag, fallback, interactive) {
  const existing = getArg(flag);
  if (existing) {
    return existing;
  }

  if (!interactive) {
    return fallback;
  }

  const choices = [
    {
      value: 'console',
      description: '本地控制台验证，最快跑通 Qodex 基础链路',
    },
    {
      value: 'qq',
      description: '接入一个 QQ 机器人，适合远程聊天驱动开发任务',
    },
    {
      value: 'wechat',
      description: '通过 ClawBot bridge 接入微信 / WebChat webhook 场景',
    },
  ];

  output.write('Channel type\n');
  for (const [index, choice] of choices.entries()) {
    const recommended = choice.value === fallback ? ' (default)' : '';
    output.write(`  ${index + 1}. ${choice.value}${recommended} - ${choice.description}\n`);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (
      await rl.question(`Choose channel [${fallback}]: `)
    ).trim();
    if (!answer) {
      return fallback;
    }

    const byIndex = Number(answer);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= choices.length) {
      return choices[byIndex - 1].value;
    }

    return answer;
  } finally {
    rl.close();
  }
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
