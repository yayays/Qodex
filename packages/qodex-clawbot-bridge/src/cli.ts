import { loadBridgeConfig } from './config.js';
import { createClawbotBridgeServer } from './server.js';

async function main(): Promise<void> {
  const configPath = getArg('--config') ?? './qodex.toml';
  const config = await loadBridgeConfig(configPath);
  const server = createClawbotBridgeServer(config);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.server.port, config.server.host, () => {
      console.log(
        `qodex-clawbot-bridge listening on http://${config.server.host}:${config.server.port}${config.server.path}`,
      );
      resolve();
    });
  });
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
