import { resolve } from 'node:path';

import { getArg, loadQodexConfig } from './qodex-runtime-utils.mjs';
import {
  buildManagedRuntimePaths,
  buildRestartPlan,
  clearManagedRuntimeRecord,
  listProcesses,
  readManagedRuntimeRecord,
  selectRestartTargets,
  startStack,
  terminateProcessGroup,
  waitForReady,
} from './qodex-restart.mjs';

const KILL_TIMEOUT_MS = 2_000;

async function main() {
  const configArg = getArg('--config') ?? './qodex.toml';
  const skipAppServer = process.argv.includes('--skip-app-server');
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

  const existingTargets = selectRestartTargets(listProcesses(), plan, runtimeRecord);
  if (existingTargets.length > 0) {
    throw new Error(`managed Qodex stack already running for config ${configPath}`);
  }

  let startedPid;
  try {
    startedPid = await startStack(plan, runtimePaths);
    await waitForReady(plan, config);
  } catch (error) {
    if (startedPid) {
      await terminateProcessGroup(startedPid, 'SIGKILL', KILL_TIMEOUT_MS);
    }
    await clearManagedRuntimeRecord(runtimePaths);
    throw error;
  }

  process.stdout.write('Qodex host started in background\n');
  process.stdout.write(`config=${configPath}\n`);
  process.stdout.write(`pid=${startedPid}\n`);
  process.stdout.write(`log=${runtimePaths.logPath}\n`);
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
