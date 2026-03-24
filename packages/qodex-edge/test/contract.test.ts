import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'toml';

import rpcContract from '../../../contracts/core-rpc.json' with { type: 'json' };
import configContract from '../../../contracts/config-contract.json' with { type: 'json' };
import dtoContract from '../../../contracts/dto-contract.json' with { type: 'json' };

import {
  CoreEvents,
  CoreMethods,
  JSONRPC_VERSION,
  type ApprovalRequestedEvent,
  type ConversationDetailsResponse,
  type ConversationRunningRuntime,
  type PendingDeliveryRecord,
  type SendMessageParams,
  type SendMessageResponse,
} from '../src/core-protocol.js';
import { loadConfig } from '../src/config.js';
import {
  BackendKinds,
  ConfigLoaderDefaults,
  type BackendKind,
} from '../src/generated/config-contract.js';
import { DtoContract } from '../src/generated/dto-contract.js';

test('protocol constants match the shared RPC contract', () => {
  assert.equal(JSONRPC_VERSION, rpcContract.jsonrpcVersion);
  assert.deepEqual(CoreMethods, rpcContract.methods);
  assert.deepEqual(CoreEvents, rpcContract.events);
});

test('generated DTO artifacts match the shared DTO contract', () => {
  assert.deepEqual(DtoContract, dtoContract);
});

test('generated config artifacts match the shared config contract', () => {
  assert.deepEqual(BackendKinds, configContract.backendKinds);
  assert.deepEqual(ConfigLoaderDefaults, configContract.loaderDefaults);

  const backendKind: BackendKind = BackendKinds[0];
  assert.ok(configContract.backendKinds.includes(backendKind));
});

test('example config covers the shared config contract sections and required fields', async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const examplePath = join(repoRoot, 'qodex.example.toml');
  const raw = await readFile(examplePath, 'utf8');
  const parsed = parse(raw) as Record<string, any>;

  for (const section of configContract.requiredSections) {
    assert.ok(section in parsed, `missing section ${section} in qodex.example.toml`);
  }

  for (const [section, fields] of Object.entries(configContract.requiredFields)) {
    const sectionValue = parsed[section] as Record<string, unknown> | undefined;
    if (!sectionValue) {
      assert.ok(
        !configContract.requiredSections.includes(section),
        `missing section ${section} in qodex.example.toml`,
      );
      continue;
    }
    for (const field of fields as string[]) {
      assert.ok(field in sectionValue, `missing field ${section}.${field} in qodex.example.toml`);
    }
  }

  const backendKind = parsed.backend?.kind;
  assert.ok(configContract.backendKinds.includes(backendKind));
});

test('critical DTO field shapes match the shared DTO contract', () => {
  const sendMessageParamsKeys = typedKeys<SendMessageParams>({
    conversation: {} as SendMessageParams['conversation'],
    sender: {} as SendMessageParams['sender'],
    text: '',
    images: [],
    workspace: undefined,
    backendKind: undefined,
    model: undefined,
    modelProvider: undefined,
  });
  assert.deepEqual(sendMessageParamsKeys, DtoContract.sendMessageParams);

  const sendMessageResponseKeys = typedKeys<SendMessageResponse>({
    accepted: true,
    conversationKey: '',
    threadId: '',
    turnId: '',
  });
  assert.deepEqual(sendMessageResponseKeys, DtoContract.sendMessageResponse);

  const approvalRequestedEventKeys = typedKeys<ApprovalRequestedEvent>({
    eventId: '',
    approvalId: '',
    conversationKey: '',
    threadId: '',
    turnId: '',
    kind: '',
    reason: undefined,
    summary: '',
    availableDecisions: [],
    payloadJson: '',
  });
  assert.deepEqual(approvalRequestedEventKeys, DtoContract.approvalRequestedEvent);

  const detailsResponseKeys = typedKeys<ConversationDetailsResponse>({
    conversation: undefined,
    runtime: undefined,
    pendingApprovals: [],
    recentMessages: [],
    recentTurn: undefined,
    recentError: undefined,
  });
  assert.deepEqual(detailsResponseKeys, DtoContract.conversationDetailsResponse);

  const runtimeKeys = typedKeys<ConversationRunningRuntime>({
    threadId: '',
    status: '',
    activeFlags: [],
    error: undefined,
  });
  assert.deepEqual(runtimeKeys, DtoContract.conversationRunningRuntime);

  const pendingDeliveryKeys = typedKeys<PendingDeliveryRecord>({
    eventId: '',
    method: '',
    conversationKey: '',
    threadId: undefined,
    turnId: undefined,
    payloadJson: '',
    createdAt: '',
  });
  assert.deepEqual(pendingDeliveryKeys, DtoContract.pendingDeliveryRecord);
});

test('shared config loader defaults match the config contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qodex-edge-contract-defaults-'));
  const configPath = join(dir, 'qodex.toml');
  await writeFile(configPath, '', 'utf8');
  const config = await loadConfig(configPath);

  assert.equal(config.server.bind, configContract.loaderDefaults['server.bind']);
  assert.equal(config.server.authToken ?? null, configContract.loaderDefaults['server.authToken']);
  assert.equal(config.backend.kind, configContract.loaderDefaults['backend.kind']);
  assert.equal(config.codex.url, configContract.loaderDefaults['codex.url']);
  assert.equal(config.codex.modelProvider ?? null, configContract.loaderDefaults['codex.modelProvider']);
  assert.equal(config.codex.approvalPolicy, configContract.loaderDefaults['codex.approvalPolicy']);
  assert.equal(config.codex.sandbox, configContract.loaderDefaults['codex.sandbox']);
  assert.equal(config.codex.experimentalApi, configContract.loaderDefaults['codex.experimentalApi']);
  assert.equal(config.codex.serviceName, configContract.loaderDefaults['codex.serviceName']);
  assert.equal(config.codex.requestTimeoutMs, configContract.loaderDefaults['codex.requestTimeoutMs']);
  assert.equal(config.opencode.url, configContract.loaderDefaults['opencode.url']);
  assert.equal(config.opencode.modelProvider ?? null, configContract.loaderDefaults['opencode.modelProvider']);
  assert.equal(config.opencode.approvalPolicy, configContract.loaderDefaults['opencode.approvalPolicy']);
  assert.equal(config.opencode.sandbox, configContract.loaderDefaults['opencode.sandbox']);
  assert.equal(config.opencode.serviceName, configContract.loaderDefaults['opencode.serviceName']);
  assert.equal(config.opencode.requestTimeoutMs, configContract.loaderDefaults['opencode.requestTimeoutMs']);
  assert.equal(config.edge.coreUrl, configContract.loaderDefaults['edge.coreUrl']);
  assert.equal(config.edge.coreAuthToken ?? null, configContract.loaderDefaults['edge.coreAuthToken']);
  assert.equal(config.edge.requestTimeoutMs, configContract.loaderDefaults['edge.requestTimeoutMs']);
  assert.equal(config.edge.streamFlushMs, configContract.loaderDefaults['edge.streamFlushMs']);
  assert.equal(
    config.edge.autoApprovePermissions,
    configContract.loaderDefaults['edge.autoApprovePermissions'],
  );
  assert.equal(config.logging.rust, configContract.loaderDefaults['logging.rust']);
  assert.equal(config.logging.node, configContract.loaderDefaults['logging.node']);
});

function typedKeys<T extends object>(value: T): string[] {
  return Object.keys(value);
}
