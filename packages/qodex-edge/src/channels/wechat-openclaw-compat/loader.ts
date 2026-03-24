import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAdapter as createTencentWechatAdapter } from './transport/tencent.js';
import type { CreateWechatCompatAdapter } from './types.js';

export async function loadWechatCompatAdapter(
  moduleRef: string,
  configDir: string,
): Promise<CreateWechatCompatAdapter> {
  const builtin = builtins.get(moduleRef);
  if (builtin) {
    return builtin;
  }
  const specifier = resolveModuleSpecifier(moduleRef, configDir);
  const loaded = (await import(specifier)) as Record<string, unknown>;
  const createAdapter = resolveCreateAdapter(loaded);
  if (!createAdapter) {
    throw new Error(
      `wechat compat adapter "${moduleRef}" does not export createAdapter()`,
    );
  }
  return createAdapter;
}

function resolveModuleSpecifier(moduleRef: string, configDir: string): string {
  if (moduleRef.startsWith('.') || isAbsolute(moduleRef)) {
    return pathToFileURL(resolve(configDir, moduleRef)).href;
  }
  return moduleRef;
}

function resolveCreateAdapter(
  moduleValue: Record<string, unknown>,
): CreateWechatCompatAdapter | undefined {
  const direct = moduleValue.createAdapter;
  if (typeof direct === 'function') {
    return direct as CreateWechatCompatAdapter;
  }

  const defaultExport = moduleValue.default;
  if (
    typeof defaultExport === 'object' &&
    defaultExport !== null &&
    typeof (defaultExport as { createAdapter?: unknown }).createAdapter === 'function'
  ) {
    return (defaultExport as { createAdapter: CreateWechatCompatAdapter }).createAdapter;
  }

  if (typeof defaultExport === 'function') {
    return defaultExport as CreateWechatCompatAdapter;
  }

  return undefined;
}

const builtins = new Map<string, CreateWechatCompatAdapter>([
  ['builtin:tencent-wechat', createTencentWechatAdapter],
]);
