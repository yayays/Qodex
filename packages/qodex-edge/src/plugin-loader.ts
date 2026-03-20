import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { consoleChannelExtension } from './channels/console.js';
import { QodexPluginExtension } from './plugin-sdk.js';

const builtins = new Map<string, QodexPluginExtension>([
  ['builtin:console', consoleChannelExtension],
]);

export async function loadPluginExtension(pluginRef: string): Promise<QodexPluginExtension> {
  const builtin = builtins.get(pluginRef);
  if (builtin) {
    return builtin;
  }

  const specifier =
    pluginRef.startsWith('.') || pluginRef.startsWith('/')
      ? pathToFileURL(resolve(pluginRef)).href
      : pluginRef;

  const module = (await import(specifier)) as Record<string, unknown>;
  const candidate =
    module.default ??
    module.qodexPlugin ??
    module.plugin;

  if (!isPluginExtension(candidate)) {
    throw new Error(
      `plugin "${pluginRef}" does not export a valid Qodex plugin extension`,
    );
  }

  return candidate;
}

function isPluginExtension(value: unknown): value is QodexPluginExtension {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { register?: unknown }).register === 'function'
  );
}
