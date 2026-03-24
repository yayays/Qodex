import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger } from '../src/logger.js';
import type { QodexConfig } from '../src/config.js';
import type { OutboundSink } from '../src/protocol.js';
import { RuntimeEventPresenter } from '../src/runtime/presenter.js';
import { RuntimeSessionState } from '../src/runtime/state.js';

class MockCoreClient {
  ackedDeliveries: string[] = [];
  respondApprovalCalls: Array<{ approvalId: string; decision: string }> = [];

  async ackDelivery(params: { eventId: string }) {
    this.ackedDeliveries.push(params.eventId);
    return {
      eventId: params.eventId,
      removed: true,
    };
  }

  async respondApproval(params: { approvalId: string; decision: string }) {
    this.respondApprovalCalls.push(params);
    return {
      approvalId: params.approvalId,
      status: 'submitted',
    };
  }
}

test('presenter streams deltas and flushes through the resolved sink', async () => {
  const core = new MockCoreClient();
  const sessionState = new RuntimeSessionState();
  const streamUpdates: string[] = [];
  const sink: OutboundSink = {
    async sendText() {},
    async sendStreamUpdate(message) {
      streamUpdates.push(message.text);
    },
  };

  const presenter = new RuntimeEventPresenter({
    core: core as any,
    logger: createLogger('fatal'),
    config: buildConfig(),
    sessionState,
    resolveSink() {
      return sink;
    },
    isFailedTurnStatus(status) {
      return /failed|error|cancel/i.test(status);
    },
  });

  await presenter.handleDelta({
    conversationKey: 'qqbot:group:presenter-stream-demo',
    threadId: 'thread-1',
    turnId: 'turn-1',
    delta: 'hello',
  });

  assert.deepEqual(streamUpdates, ['hello']);
  assert.equal(
    sessionState.streamState.get('qqbot:group:presenter-stream-demo:turn-1')?.text,
    'hello',
  );
});

test('presenter renders approval messages and acknowledges deliveries directly', async () => {
  const core = new MockCoreClient();
  const sessionState = new RuntimeSessionState();
  const messages: Array<{ kind: string; text: string }> = [];
  const sink: OutboundSink = {
    async sendText(message) {
      messages.push({ kind: message.kind, text: message.text });
    },
  };

  const presenter = new RuntimeEventPresenter({
    core: core as any,
    logger: createLogger('fatal'),
    config: buildConfig(),
    sessionState,
    resolveSink() {
      return sink;
    },
    isFailedTurnStatus(status) {
      return /failed|error|cancel/i.test(status);
    },
  });

  await presenter.handleApproval({
    eventId: 'evt-approval-1',
    approvalId: 'approval-very-long-12345',
    conversationKey: 'qqbot:group:presenter-approval-demo',
    threadId: 'thread-1',
    turnId: 'turn-1',
    kind: 'commandExecution',
    reason: 'Need shell access',
    summary: 'Command execution approval requested',
    availableDecisions: ['accept', 'decline'],
    payloadJson: JSON.stringify({ command: 'cargo test' }),
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'approval');
  assert.match(messages[0].text, /需要确认：approval-ver/);
  assert.match(messages[0].text, /command=cargo test/);
  assert.deepEqual(core.ackedDeliveries, ['evt-approval-1']);
});

test('presenter auto-approves permission requests when enabled', async () => {
  const core = new MockCoreClient();
  const sessionState = new RuntimeSessionState();
  sessionState.setAutoApprovePermissions('qqbot:group:presenter-auto-approval-demo', true);
  const messages: Array<{ kind: string; text: string }> = [];
  const sink: OutboundSink = {
    async sendText(message) {
      messages.push({ kind: message.kind, text: message.text });
    },
  };

  const presenter = new RuntimeEventPresenter({
    core: core as any,
    logger: createLogger('fatal'),
    config: buildConfig(),
    sessionState,
    resolveSink() {
      return sink;
    },
    isFailedTurnStatus(status) {
      return /failed|error|cancel/i.test(status);
    },
  });

  await presenter.handleApproval({
    eventId: 'evt-approval-2',
    approvalId: 'approval-perm-1',
    conversationKey: 'qqbot:group:presenter-auto-approval-demo',
    threadId: 'thread-1',
    turnId: 'turn-1',
    kind: 'permissions',
    reason: 'Need network',
    summary: 'Permission approval requested',
    availableDecisions: ['accept', 'decline'],
    payloadJson: JSON.stringify({ permissions: { network: true } }),
  });

  assert.deepEqual(core.respondApprovalCalls, [
    { approvalId: 'approval-perm-1', decision: 'accept' },
  ]);
  assert.equal(messages[0]?.kind, 'system');
  assert.match(messages[0]?.text ?? '', /Auto-approved permission request/);
  assert.deepEqual(core.ackedDeliveries, ['evt-approval-2']);
});

function buildConfig(): QodexConfig {
  return {
    server: {
      bind: '127.0.0.1:7820',
    },
    edge: {
      coreUrl: 'ws://127.0.0.1:7820/ws',
      requestTimeoutMs: 30_000,
      streamFlushMs: 0,
      autoApprovePermissions: false,
    },
    logging: {
      rust: 'fatal',
      node: 'fatal',
    },
    backend: {
      kind: 'codex',
      defaultWorkspace: '/tmp/qodex',
    },
    codex: {
      url: 'ws://127.0.0.1:8765',
      model: undefined,
      modelProvider: undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      experimentalApi: false,
      serviceName: 'Qodex',
      defaultWorkspace: '/tmp/qodex',
      allowedWorkspaces: ['/tmp/qodex'],
      requestTimeoutMs: 30_000,
    },
    opencode: {
      url: 'http://127.0.0.1:4096',
      model: undefined,
      modelProvider: undefined,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      serviceName: 'Qodex',
      requestTimeoutMs: 30_000,
    },
    channels: [],
  };
}
