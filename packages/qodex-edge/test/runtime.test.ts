import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { QodexConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import type { PlatformMessage, OutboundSink } from '../src/platform-protocol.js';
import { QodexEdgeRuntime } from '../src/runtime.js';

const RUNTIME_IDLE_TTL_MS = 60 * 60_000;

class MockCoreClient extends EventEmitter {
  sendMessageCalls = 0;
  saveFilesCalls = 0;
  lastSendMessageParams: any;
  lastSaveFilesParams: any;
  lastNewThreadParams: any;
  lastRespondApprovalParams: any;
  respondApprovalCalls: any[] = [];
  lastRememberMemoryParams: any;
  lastForgetMemoryParams: any;
  lastGetMemoryProfileParams: any;
  lastUpsertMemoryProfileParams: any;
  lastGetConversationSummaryParams: any;
  lastUpsertConversationSummaryParams: any;
  lastClearConversationSummaryParams: any;
  lastAddPromptHintParams: any;
  lastRemovePromptHintParams: any;
  statusResponse: any = {
    conversation: null,
    pendingApprovals: [],
  };
  runningResponse: any = {
    conversation: null,
    runtime: null,
  };
  detailsResponse: any = {
    conversation: null,
    runtime: null,
    pendingApprovals: [],
    recentMessages: [],
    recentTurn: null,
    recentError: null,
  };
  pendingDeliveries: any = {
    pending: [],
  };
  memoryContextResponse: any = {
    link: {
      conversationKey: 'qqbot:group:demo',
      botInstance: 'qqbot',
      workspace: '/tmp/qodex',
      userKey: 'qqbot:group:tester',
      createdAt: '2026-03-23T00:00:00.000Z',
      updatedAt: '2026-03-23T00:00:00.000Z',
    },
    conversationSummary: null,
    profiles: [],
    promptHints: [],
    facts: [],
  };
  memoryProfileResponse: any = {
    profile: null,
  };
  conversationSummaryResponse: any = {
    summary: null,
  };
  ackedDeliveries: string[] = [];
  sendMessageResponse: any = {
    accepted: true,
    conversationKey: 'qqbot:group:demo',
    threadId: 'thread-test-1',
    turnId: 'turn-test-1',
  };
  saveFilesResponse: any = {
    conversationKey: 'qqbot:group:demo',
    savedFiles: [],
  };

  async connect(): Promise<void> {}

  async sendMessage(params?: unknown) {
    this.sendMessageCalls += 1;
    this.lastSendMessageParams = params;
    return this.sendMessageResponse;
  }

  async saveFiles(params?: unknown) {
    this.saveFilesCalls += 1;
    this.lastSaveFilesParams = params;
    return this.saveFilesResponse;
  }

  async bindWorkspace() {
    return {
      conversation: null,
      pendingApprovals: [],
    };
  }

  async newThread(params?: unknown) {
    this.lastNewThreadParams = params;
    return {
      conversation: null,
      pendingApprovals: [],
    };
  }

  async status() {
    return this.statusResponse;
  }

  async details() {
    return this.detailsResponse;
  }

  async running() {
    return this.runningResponse;
  }

  async listMemory() {
    return this.memoryContextResponse;
  }

  async rememberMemory(params?: unknown) {
    this.lastRememberMemoryParams = params;
    return {
      fact: {
        id: 'mem-1',
        scopeType: (params as any)?.scopeType ?? 'user',
        scopeKey: 'qqbot:group:tester',
        category: (params as any)?.category ?? 'preference',
        content: (params as any)?.content ?? '默认用中文回复',
        confidence: 1,
        source: 'manual',
        status: 'active',
        createdAt: '2026-03-23T00:00:00.000Z',
        updatedAt: '2026-03-23T00:00:00.000Z',
      },
    };
  }

  async forgetMemory(params?: { id: string }) {
    this.lastForgetMemoryParams = params;
    return {
      id: params?.id ?? 'mem-1',
      archived: true,
    };
  }

  async getMemoryProfile(params?: unknown) {
    this.lastGetMemoryProfileParams = params;
    return this.memoryProfileResponse;
  }

  async upsertMemoryProfile(params?: unknown) {
    this.lastUpsertMemoryProfileParams = params;
    return {
      profile: {
        scopeType: (params as any)?.scopeType ?? 'user',
        scopeKey: 'qqbot:group:tester',
        profileJson: JSON.stringify((params as any)?.profile ?? {}),
        version: 2,
        createdAt: '2026-03-23T00:00:00.000Z',
        updatedAt: '2026-03-23T00:05:00.000Z',
      },
    };
  }

  async getConversationSummary(params?: unknown) {
    this.lastGetConversationSummaryParams = params;
    return this.conversationSummaryResponse;
  }

  async upsertConversationSummary(params?: unknown) {
    this.lastUpsertConversationSummaryParams = params;
    return {
      summary: {
        conversationKey: (params as any)?.conversationKey ?? 'qqbot:group:demo',
        summaryText: (params as any)?.summaryText ?? 'summary',
        version: 2,
        createdAt: '2026-03-23T00:00:00.000Z',
        updatedAt: '2026-03-23T00:05:00.000Z',
      },
    };
  }

  async clearConversationSummary(params?: unknown) {
    this.lastClearConversationSummaryParams = params;
    return {
      conversationKey: (params as any)?.conversationKey ?? 'qqbot:group:demo',
      cleared: true,
    };
  }

  async addPromptHint(params?: unknown) {
    this.lastAddPromptHintParams = params;
    return {
      hint: {
        id: 'hint-1',
        scopeType: (params as any)?.scopeType ?? 'user',
        scopeKey: 'qqbot:group:tester',
        hintText: (params as any)?.hintText ?? '默认中文回复',
        status: 'active',
        createdAt: '2026-03-23T00:00:00.000Z',
        updatedAt: '2026-03-23T00:00:00.000Z',
      },
    };
  }

  async removePromptHint(params?: unknown) {
    this.lastRemovePromptHintParams = params;
    return {
      id: (params as any)?.id ?? 'hint-1',
      archived: true,
    };
  }

  async listPendingDeliveries() {
    return this.pendingDeliveries;
  }

  async ackDelivery(params: { eventId: string }) {
    this.ackedDeliveries.push(params.eventId);
    return {
      eventId: params.eventId,
      removed: true,
    };
  }

  async ping() {
    return {
      pong: true,
    };
  }

  async respondApproval(params?: unknown) {
    this.lastRespondApprovalParams = params;
    this.respondApprovalCalls.push(params);
    return {
      approvalId: (params as { approvalId?: string } | undefined)?.approvalId ?? 'approval-test-1',
      status: 'submitted',
    };
  }
}

test('prunes idle sink state after idle turn bookkeeping expires', async () => {
  const runtime = createRuntime();
  const { sink, messages } = createSink();
  const message = buildMessage('qqbot:group:prune-demo');

  await runtime.handleIncoming(message, sink);

  const state = runtime as any;
  const turnKey = `${message.conversation.conversationKey}:turn-test-1`;
  state.sinks.get(message.conversation.conversationKey).lastActivityAt =
    Date.now() - RUNTIME_IDLE_TTL_MS - 1;
  state.activeTurns.get(turnKey).lastActivityAt = Date.now() - RUNTIME_IDLE_TTL_MS - 1;
  state.lastPrunedAt = 0;
  state.pruneIdleState();

  assert.equal(messages.length, 0);
  assert.equal(state.activeTurns.size, 0);
  assert.equal(state.sinks.size, 0);
});

test('keeps the sink while the turn is still active', async () => {
  const runtime = createRuntime();
  const { sink } = createSink();
  const message = buildMessage('qqbot:group:active-demo');

  await runtime.handleIncoming(message, sink);

  const state = runtime as any;
  state.sinks.get(message.conversation.conversationKey).lastActivityAt =
    Date.now() - RUNTIME_IDLE_TTL_MS - 1;
  state.lastPrunedAt = 0;
  state.pruneIdleState();

  assert.equal(state.activeTurns.size, 1);
  assert.equal(state.sinks.size, 1);
});

test('running command reports active turn before first output', async () => {
  const core = new MockCoreClient();
  core.runningResponse = {
    conversation: {
      conversationKey: 'qqbot:group:running-demo',
      platform: 'qqbot',
      scope: 'group',
      externalId: 'running-demo',
      workspace: '/tmp/qodex',
      threadId: 'thread-test-1',
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T00:00:00.000Z',
    },
    runtime: {
      threadId: 'thread-test-1',
      status: 'active',
      activeFlags: [],
    },
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();
  const conversationKey = 'qqbot:group:running-demo';

  await runtime.handleIncoming(buildMessage(conversationKey), sink);
  await runtime.handleIncoming(buildMessage(conversationKey, '/running'), sink);

  const runningReply = messages.at(-1);
  assert.ok(runningReply);
  assert.equal(runningReply.kind, 'system');
  assert.match(runningReply.text, /reports this conversation is active/i);
  assert.match(runningReply.text, /backendStatus=active/);
  assert.match(runningReply.text, /activeTurn=turn-test-1/);
  assert.match(runningReply.text, /output=waiting-first-output/);
});

test('status command includes streaming processing state after delta', async () => {
  const runtime = createRuntime();
  const { sink, messages } = createSink();
  const conversationKey = 'qqbot:group:status-demo';

  await runtime.handleIncoming(buildMessage(conversationKey), sink);
  await (runtime as any).handleDelta({
    conversationKey,
    threadId: 'thread-test-1',
    turnId: 'turn-test-1',
    delta: 'hello',
  });
  await runtime.handleIncoming(buildMessage(conversationKey, '/status'), sink);

  const statusReply = messages.at(-1);
  assert.ok(statusReply);
  assert.equal(statusReply.kind, 'system');
  assert.match(statusReply.text, /Current state/);
  assert.match(statusReply.text, /processing=active/);
  assert.match(statusReply.text, /output=streaming/);
});

test('running command reports idle with no active turn', async () => {
  const core = new MockCoreClient();
  core.runningResponse = {
    conversation: null,
    runtime: null,
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();
  const conversationKey = 'qqbot:group:idle-running-demo';

  await runtime.handleIncoming(buildMessage(conversationKey, '/running'), sink);

  const runningReply = messages.at(-1);
  assert.ok(runningReply);
  assert.equal(runningReply.kind, 'system');
  assert.match(runningReply.text, /healthy and idle/i);
  assert.match(runningReply.text, /backendStatus=uninitialized/);
});

test('help command surfaces the configured backend kind', async () => {
  const runtime = createRuntime();
  const { sink, messages } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:help-demo', '/help'), sink);

  const helpReply = messages.at(-1);
  assert.ok(helpReply);
  assert.match(helpReply.text, /backend=codex/);
  assert.match(helpReply.text, /defaultWorkspace=\/tmp\/qodex/);
});

test('help command honors per-message backend selection', async () => {
  const runtime = createRuntime();
  const { sink, messages } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:help-opencode-demo', '/help', undefined, 'opencode'),
    sink,
  );

  const helpReply = messages.at(-1);
  assert.ok(helpReply);
  assert.match(helpReply.text, /backend=opencode/);
});

test('new command forwards the per-message backend selection', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:new-opencode-demo', '/new', undefined, 'opencode'),
    sink,
  );

  assert.deepEqual(core.lastNewThreadParams, {
    conversationKey: 'qqbot:group:new-opencode-demo',
    backendKind: 'opencode',
  });
});

test('memory command renders active memory context', async () => {
  const core = new MockCoreClient();
  core.memoryContextResponse = {
    link: {
      conversationKey: 'qqbot:group:memory-demo',
      botInstance: 'qqbot',
      workspace: '/tmp/qodex',
      userKey: 'qqbot:group:tester',
      createdAt: '2026-03-23T00:00:00.000Z',
      updatedAt: '2026-03-23T00:00:00.000Z',
    },
    conversationSummary: {
      conversationKey: 'qqbot:group:memory-demo',
      summaryText: '已经确认仓库结构与交付边界。',
      version: 1,
      createdAt: '2026-03-23T00:00:00.000Z',
      updatedAt: '2026-03-23T00:00:00.000Z',
    },
    profiles: [
      {
        scopeType: 'user',
        scopeKey: 'qqbot:group:tester',
        profileJson: JSON.stringify({ language: 'zh-CN', style: 'concise' }),
        version: 1,
        createdAt: '2026-03-23T00:00:00.000Z',
        updatedAt: '2026-03-23T00:00:00.000Z',
      },
    ],
    promptHints: [
      {
        id: 'hint-1',
        scopeType: 'user',
        scopeKey: 'qqbot:group:tester',
        hintText: '优先给出可执行命令',
        status: 'active',
        createdAt: '2026-03-23T00:00:00.000Z',
        updatedAt: '2026-03-23T00:00:00.000Z',
      },
    ],
    facts: [
      {
        id: 'mem-1',
        scopeType: 'workspace',
        scopeKey: '/tmp/qodex',
        category: 'repo_rule',
        content: 'prefer minimal diffs',
        confidence: 1,
        source: 'manual',
        status: 'active',
        createdAt: '2026-03-23T00:00:00.000Z',
        updatedAt: '2026-03-23T00:00:00.000Z',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:memory-demo', '/memory'), sink);

  const reply = messages.at(-1);
  assert.ok(reply);
  assert.match(reply.text, /Active memory/);
  assert.match(reply.text, /bot=qqbot/);
  assert.match(reply.text, /summary=已经确认仓库结构与交付边界/);
  assert.match(reply.text, /{"language":"zh-CN","style":"concise"}/);
  assert.match(reply.text, /hint-1 user 优先给出可执行命令/);
  assert.match(reply.text, /mem-1 workspace \[repo_rule\] prefer minimal diffs/);
});

test('remember command forwards scoped memory writes', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:remember-demo', '/remember user preference 默认用中文回复'),
    sink,
  );

  assert.equal(core.lastRememberMemoryParams.scopeType, 'user');
  assert.equal(core.lastRememberMemoryParams.category, 'preference');
  assert.equal(core.lastRememberMemoryParams.content, '默认用中文回复');
  assert.equal(core.lastRememberMemoryParams.botInstance, 'qqbot');
  assert.equal(core.lastRememberMemoryParams.userKey, 'qqbot:group:tester');
  assert.match(messages.at(-1)?.text ?? '', /Memory saved/);
});

test('forget command archives a memory by id', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:forget-demo', '/forget mem-123'),
    sink,
  );

  assert.deepEqual(core.lastForgetMemoryParams, { id: 'mem-123' });
  assert.match(messages.at(-1)?.text ?? '', /Memory archived: mem-123/);
});

test('profile command supports nested assignment, append, remove, and delete', async () => {
  const core = new MockCoreClient();
  core.memoryProfileResponse = {
    profile: {
      scopeType: 'user',
      scopeKey: 'qqbot:group:tester',
      profileJson: JSON.stringify({
        language: 'zh-CN',
        preferences: {
          tone: 'direct',
        },
        tags: ['rust', 'ts'],
        obsolete: true,
      }),
      version: 1,
      createdAt: '2026-03-23T00:00:00.000Z',
      updatedAt: '2026-03-23T00:00:00.000Z',
    },
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(
    buildMessage(
      'qqbot:group:profile-demo',
      '/profile user preferences.style=concise tags+=memory tags-=ts !obsolete flags={"safe":true}',
    ),
    sink,
  );

  assert.equal(core.lastGetMemoryProfileParams.scopeType, 'user');
  assert.deepEqual(core.lastUpsertMemoryProfileParams.profile, {
    language: 'zh-CN',
    preferences: {
      tone: 'direct',
      style: 'concise',
    },
    tags: ['rust', 'memory'],
    flags: {
      safe: true,
    },
  });
  assert.match(messages.at(-1)?.text ?? '', /Profile updated/);
  assert.match(messages.at(-1)?.text ?? '', /"style":"concise"/);
});

test('summary command reads and updates conversation summary', async () => {
  const core = new MockCoreClient();
  core.conversationSummaryResponse = {
    summary: {
      conversationKey: 'qqbot:group:summary-demo',
      summaryText: '已有摘要',
      version: 1,
      createdAt: '2026-03-23T00:00:00.000Z',
      updatedAt: '2026-03-23T00:00:00.000Z',
    },
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:summary-demo', '/summary'), sink);
  await runtime.handleIncoming(
    buildMessage('qqbot:group:summary-demo', '/summary 新一轮开始，已锁定目标接口'),
    sink,
  );

  assert.deepEqual(core.lastGetConversationSummaryParams, {
    conversationKey: 'qqbot:group:summary-demo',
  });
  assert.deepEqual(core.lastUpsertConversationSummaryParams, {
    conversationKey: 'qqbot:group:summary-demo',
    summaryText: '新一轮开始，已锁定目标接口',
  });
  assert.match(messages[0].text, /text=已有摘要/);
  assert.match(messages[1].text, /Conversation summary updated/);
});

test('hint and unhint commands forward prompt hint writes', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:hint-demo', '/hint workspace 回答先给结论再展开'),
    sink,
  );
  await runtime.handleIncoming(
    buildMessage('qqbot:group:hint-demo', '/unhint hint-123'),
    sink,
  );

  assert.equal(core.lastAddPromptHintParams.scopeType, 'workspace');
  assert.equal(core.lastAddPromptHintParams.hintText, '回答先给结论再展开');
  assert.equal(core.lastRemovePromptHintParams.id, 'hint-123');
  assert.match(messages[0].text, /Prompt hint saved/);
  assert.match(messages[1].text, /Prompt hint archived: hint-123/);
});

test('running command uses the configured backend label in status copy', async () => {
  const core = new MockCoreClient();
  core.runningResponse = {
    conversation: {
      conversationKey: 'qqbot:group:opencode-running-demo',
      platform: 'qqbot',
      scope: 'group',
      externalId: 'opencode-running-demo',
      workspace: '/tmp/qodex',
      threadId: 'thread-test-1',
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T00:00:00.000Z',
    },
    runtime: {
      threadId: 'thread-test-1',
      status: 'active',
      activeFlags: [],
    },
  };
  const runtime = createRuntime(core, buildConfig('opencode'));
  const { sink, messages } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:opencode-running-demo', '/running'), sink);

  const runningReply = messages.at(-1);
  assert.ok(runningReply);
  assert.match(runningReply.text, /OpenCode backend reports this conversation is active/i);
  assert.match(runningReply.text, /backendStatus=active/);
});

test('status+ command includes recent history, runtime, and channel health', async () => {
  const core = new MockCoreClient();
  core.detailsResponse = {
    conversation: {
      conversationKey: 'qqbot:group:status-plus-demo',
      platform: 'qqbot',
      scope: 'group',
      externalId: 'status-plus-demo',
      workspace: '/tmp/qodex',
      threadId: 'thread-test-1',
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T00:00:00.000Z',
    },
    runtime: {
      threadId: 'thread-test-1',
      status: 'active',
      activeFlags: ['waitingOnApproval'],
    },
    pendingApprovals: [
      {
        approvalId: 'approval-1',
        requestId: 'request-1',
        conversationKey: 'qqbot:group:status-plus-demo',
        threadId: 'thread-test-1',
        turnId: 'turn-test-9',
        itemId: 'item-1',
        kind: 'commandExecution',
        reason: 'Need shell access',
        payloadJson: JSON.stringify({ command: 'cargo test' }),
        status: 'pending',
        createdAt: '2026-03-19T00:01:00.000Z',
      },
    ],
    recentMessages: [
      {
        role: 'user',
        content: 'please run tests',
        threadId: 'thread-test-1',
        turnId: 'turn-test-9',
        createdAt: '2026-03-19T00:00:30.000Z',
      },
    ],
    recentTurn: {
      threadId: 'thread-test-1',
      turnId: 'turn-test-9',
      status: 'waitingApproval',
      createdAt: '2026-03-19T00:01:00.000Z',
    },
    recentError: {
      threadId: 'thread-test-1',
      turnId: 'turn-test-8',
      message: 'backend timeout',
      createdAt: '2026-03-19T00:00:10.000Z',
    },
  };

  const runtime = createRuntime(core);
  runtime.attachHost({
    resolveSinkForConversation() {
      return undefined;
    },
    listConversationChannels() {
      return [
        {
          instanceId: 'qq',
          channelId: 'qqbot',
          status: {
            connected: true,
            lastError: undefined,
          },
        },
      ];
    },
  });
  const { sink, messages } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:status-plus-demo', '/status+'), sink);

  const statusReply = messages.at(-1);
  assert.ok(statusReply);
  assert.match(statusReply.text, /Current state\+/);
  assert.match(statusReply.text, /recentTurn=turn-test-9 status=waitingApproval/);
  assert.match(statusReply.text, /recentError=backend timeout/);
  assert.match(statusReply.text, /channelHealth=qq:qqbot:connected=true:lastError=none/);
  assert.match(statusReply.text, /\[user\].*please run tests/);
  assert.match(statusReply.text, /approval-1 \(commandExecution\)/);
});

test('short greeting gets a local quick reply without starting codex', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:hello-demo', '你在么'), sink);

  assert.equal(core.sendMessageCalls, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'system');
  assert.equal(messages[0].text, '在的，你可以直接说需求。');
});

test('task-like greeting still goes to codex without chat ack by default', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:task-greeting-demo', '你好，帮我看下这个报错'),
    sink,
  );

  assert.equal(core.sendMessageCalls, 1);
  assert.equal(messages.length, 0);
});

test('accepted ack is preserved for debug sinks', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink, messages } = createSink({ showAcceptedAck: true });

  await runtime.handleIncoming(
    buildMessage('console:c2c:task-greeting-demo', '你好，帮我看下这个报错'),
    sink,
  );

  assert.equal(core.sendMessageCalls, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'system');
  assert.match(messages[0].text, /Qodex accepted message/);
});

test('image inputs are forwarded to core sendMessage', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:image-demo', '识别这张图', [
      {
        url: 'https://cdn.example.com/example.png',
        mimeType: 'image/png',
        filename: 'example.png',
      },
    ]),
    sink,
  );

  assert.equal(core.sendMessageCalls, 1);
  assert.deepEqual(core.lastSendMessageParams.images, [
    {
      url: 'https://cdn.example.com/example.png',
      mimeType: 'image/png',
      filename: 'example.png',
    },
  ]);
});

test('image-only input is intercepted before reaching core sendMessage', async () => {
  const core = new MockCoreClient();
  core.saveFilesResponse = {
    conversationKey: 'qqbot:group:image-only-demo',
    savedFiles: [
      {
        filename: 'example.png',
        savedPath: '/tmp/qodex/uploadfile/2026-03-25/example.png',
        source: 'remote',
        status: 'saved',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:image-only-demo', '', [
      {
        url: 'https://cdn.example.com/example.png',
        mimeType: 'image/png',
      },
    ]),
    sink,
  );

  assert.equal(core.sendMessageCalls, 0);
  assert.equal(core.saveFilesCalls, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /图片已保存/);
});

test('file inputs are forwarded to core sendMessage', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink } = createSink();

  await runtime.handleIncoming(
    buildMessage(
      'qqbot:group:file-demo',
      '请处理这个文件',
      undefined,
      undefined,
      [
        {
          source: 'remote',
          url: 'https://cdn.example.com/notes.pdf',
          mimeType: 'application/pdf',
          filename: 'notes.pdf',
          size: 4096,
        },
      ],
    ),
    sink,
  );

  assert.equal(core.sendMessageCalls, 1);
  assert.deepEqual(core.lastSendMessageParams.files, [
    {
      source: 'remote',
      url: 'https://cdn.example.com/notes.pdf',
      mimeType: 'application/pdf',
      filename: 'notes.pdf',
      size: 4096,
    },
  ]);
});

test('saved file paths are reported back to the user after sendMessage', async () => {
  const core = new MockCoreClient();
  core.sendMessageResponse = {
    accepted: true,
    conversationKey: 'qqbot:group:file-save-demo',
    threadId: 'thread-test-1',
    turnId: 'turn-test-1',
    savedFiles: [
      {
        filename: 'notes.pdf',
        savedPath: '/tmp/qodex/uploadfile/2026-03-25/notes.pdf',
        source: 'remote',
        status: 'saved',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:file-save-demo', '请保存这个文件'),
    sink,
  );

  assert.equal(core.sendMessageCalls, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'system');
  assert.match(messages[0].text, /notes\.pdf/);
  assert.match(messages[0].text, /\/tmp\/qodex\/uploadfile\/2026-03-25\/notes\.pdf/);
});

test('image-only input is intercepted, saved, and prompts for handling instructions', async () => {
  const core = new MockCoreClient();
  core.saveFilesResponse = {
    conversationKey: 'qqbot:group:image-pending-demo',
    savedFiles: [
      {
        filename: 'screenshot.png',
        savedPath: '/tmp/qodex/uploadfile/2026-03-25/screenshot.png',
        source: 'remote',
        status: 'saved',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:image-pending-demo', '', [
      {
        url: 'https://cdn.example.com/screenshot.png',
        mimeType: 'image/png',
        filename: 'screenshot.png',
      },
    ]),
    sink,
  );

  assert.equal(core.saveFilesCalls, 1);
  assert.equal(core.sendMessageCalls, 0);
  assert.deepEqual(core.lastSaveFilesParams.files, [
    {
      source: 'remote',
      url: 'https://cdn.example.com/screenshot.png',
      mimeType: 'image/png',
      filename: 'screenshot.png',
    },
  ]);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /screenshot\.png/);
  assert.match(messages[0].text, /怎么处理/);
});

test('next handling reply sends pending image path to backend and clears pending state', async () => {
  const core = new MockCoreClient();
  core.saveFilesResponse = {
    conversationKey: 'qqbot:group:image-reply-demo',
    savedFiles: [
      {
        filename: 'screenshot.png',
        savedPath: '/tmp/qodex/uploadfile/2026-03-25/screenshot.png',
        source: 'remote',
        status: 'saved',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:image-reply-demo', '', [
      {
        url: 'https://cdn.example.com/screenshot.png',
        mimeType: 'image/png',
        filename: 'screenshot.png',
      },
    ]),
    sink,
  );
  messages.length = 0;

  await runtime.handleIncoming(
    buildMessage('qqbot:group:image-reply-demo', '是，识别这个图片'),
    sink,
  );

  assert.equal(core.saveFilesCalls, 1);
  assert.equal(core.sendMessageCalls, 1);
  assert.match(core.lastSendMessageParams.text, /是，识别这个图片/);
  assert.match(core.lastSendMessageParams.text, /\/tmp\/qodex\/uploadfile\/2026-03-25\/screenshot\.png/);
  assert.equal(messages.length, 0);
});

test('non-handling reply clears pending image and processes the text normally', async () => {
  const core = new MockCoreClient();
  core.saveFilesResponse = {
    conversationKey: 'qqbot:group:image-cancel-demo',
    savedFiles: [
      {
        filename: 'screenshot.png',
        savedPath: '/tmp/qodex/uploadfile/2026-03-25/screenshot.png',
        source: 'remote',
        status: 'saved',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:image-cancel-demo', '', [
      {
        url: 'https://cdn.example.com/screenshot.png',
        mimeType: 'image/png',
        filename: 'screenshot.png',
      },
    ]),
    sink,
  );
  messages.length = 0;

  await runtime.handleIncoming(
    buildMessage('qqbot:group:image-cancel-demo', '等一下'),
    sink,
  );

  assert.equal(core.sendMessageCalls, 1);
  assert.equal(core.lastSendMessageParams.text, '等一下');
  assert.equal(messages.length, 0);

  await runtime.handleIncoming(
    buildMessage('qqbot:group:image-cancel-demo', '识别这个图片'),
    sink,
  );

  assert.equal(core.sendMessageCalls, 2);
  assert.equal(core.lastSendMessageParams.text, '识别这个图片');
});

test('per-message codex overrides are forwarded to core sendMessage', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink } = createSink();

  await runtime.handleIncoming(
    {
      ...buildMessage('qqbot-secondary:group:model-demo', '请处理这个任务', undefined, 'opencode'),
      codex: {
        model: 'qq-secondary-model',
        modelProvider: 'qq-secondary-provider',
      },
    },
    sink,
  );

  assert.equal(core.sendMessageCalls, 1);
  assert.equal(core.lastSendMessageParams.backendKind, 'opencode');
  assert.equal(core.lastSendMessageParams.model, 'qq-secondary-model');
  assert.equal(core.lastSendMessageParams.modelProvider, 'qq-secondary-provider');
});

test('running command reports backend status errors', async () => {
  const core = new MockCoreClient();
  core.runningResponse = {
    conversation: {
      conversationKey: 'qqbot:group:running-error-demo',
      platform: 'qqbot',
      scope: 'group',
      externalId: 'running-error-demo',
      workspace: '/tmp/qodex',
      threadId: 'thread-test-1',
      createdAt: '2026-03-19T00:00:00.000Z',
      updatedAt: '2026-03-19T00:00:00.000Z',
    },
    runtime: {
      threadId: 'thread-test-1',
      status: 'unavailable',
      activeFlags: [],
      error: 'backend timeout',
    },
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:running-error-demo', '/running'), sink);

  const runningReply = messages.at(-1);
  assert.ok(runningReply);
  assert.match(runningReply.text, /could not confirm the Codex backend thread status/i);
  assert.match(runningReply.text, /backendStatus=unavailable/);
  assert.match(runningReply.text, /backendError=backend timeout/);
});

test('recoverPendingDeliveries replays approval events and acknowledges them', async () => {
  const core = new MockCoreClient();
  core.pendingDeliveries = {
    pending: [
      {
        eventId: 'evt-approval-1',
        method: 'approval/requested',
        conversationKey: 'qqbot:group:recovery-demo',
        threadId: 'thread-test-1',
        turnId: 'turn-test-1',
        payloadJson: JSON.stringify({
          eventId: 'evt-approval-1',
          approvalId: 'approval-1',
          conversationKey: 'qqbot:group:recovery-demo',
          threadId: 'thread-test-1',
          turnId: 'turn-test-1',
          kind: 'commandExecution',
          reason: 'Need shell access',
          summary: 'Command execution approval requested',
          availableDecisions: ['accept', 'decline'],
          payloadJson: JSON.stringify({ command: 'cargo test' }),
        }),
        createdAt: '2026-03-19T00:00:00.000Z',
      },
    ],
  };

  const runtime = createRuntime(core);
  const { sink, messages } = createSink();
  runtime.attachHost({
    resolveSinkForConversation() {
      return sink;
    },
    listConversationChannels() {
      return [];
    },
  });

  await runtime.recoverPendingDeliveries();

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'approval');
  assert.match(messages[0].text, /需要确认：approval-1/);
  assert.match(messages[0].text, /command=cargo test/);
  assert.deepEqual(core.ackedDeliveries, ['evt-approval-1']);
});

test('approve resolves the only pending approval when id is omitted', async () => {
  const core = new MockCoreClient();
  core.statusResponse = {
    conversation: null,
    pendingApprovals: [
      {
        approvalId: 'approval-very-long-12345',
        requestId: 'request-1',
        conversationKey: 'qqbot:group:approval-demo',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        kind: 'commandExecution',
        payloadJson: '{}',
        status: 'pending',
        createdAt: '2026-03-19T00:00:00.000Z',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:approval-demo', '/approve'), sink);

  assert.deepEqual(core.lastRespondApprovalParams, {
    approvalId: 'approval-very-long-12345',
    decision: 'accept',
  });
  assert.match(messages.at(-1)?.text ?? '', /submitted/);
});

test('reject resolves approval by short id token', async () => {
  const core = new MockCoreClient();
  core.statusResponse = {
    conversation: null,
    pendingApprovals: [
      {
        approvalId: 'approval-very-long-12345',
        requestId: 'request-1',
        conversationKey: 'qqbot:group:approval-demo',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        kind: 'commandExecution',
        payloadJson: '{}',
        status: 'pending',
        createdAt: '2026-03-19T00:00:00.000Z',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink } = createSink();

  await runtime.handleIncoming(
    buildMessage('qqbot:group:approval-demo', '/reject approval-ver'),
    sink,
  );

  assert.deepEqual(core.lastRespondApprovalParams, {
    approvalId: 'approval-very-long-12345',
    decision: 'decline',
  });
});

test('approveall toggles auto-approve and resolves pending permission approvals', async () => {
  const core = new MockCoreClient();
  core.statusResponse = {
    conversation: null,
    pendingApprovals: [
      {
        approvalId: 'perm-approval-1',
        requestId: 'request-1',
        conversationKey: 'qqbot:group:approval-demo',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        kind: 'permissions',
        payloadJson: '{}',
        status: 'pending',
        createdAt: '2026-03-19T00:00:00.000Z',
      },
      {
        approvalId: 'cmd-approval-1',
        requestId: 'request-2',
        conversationKey: 'qqbot:group:approval-demo',
        threadId: 'thread-1',
        turnId: 'turn-2',
        itemId: 'item-2',
        kind: 'commandExecution',
        payloadJson: '{}',
        status: 'pending',
        createdAt: '2026-03-19T00:00:01.000Z',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:approval-demo', '/approveall on'), sink);
  await runtime.handleIncoming(buildMessage('qqbot:group:approval-demo', '/approveall'), sink);
  await runtime.handleIncoming(buildMessage('qqbot:group:approval-demo', '/approveall off'), sink);

  assert.deepEqual(core.respondApprovalCalls, [
    {
      approvalId: 'perm-approval-1',
      decision: 'accept',
    },
  ]);
  assert.match(messages[0].text, /Auto-approve permissions enabled/);
  assert.match(messages[1].text, /is ON/);
  assert.match(messages[2].text, /disabled/);
});

test('approve supports latest and numeric index tokens', async () => {
  const core = new MockCoreClient();
  core.statusResponse = {
    conversation: null,
    pendingApprovals: [
      {
        approvalId: 'approval-latest-1',
        requestId: 'request-1',
        conversationKey: 'qqbot:group:approval-demo',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        kind: 'commandExecution',
        payloadJson: '{}',
        status: 'pending',
        createdAt: '2026-03-19T00:00:00.000Z',
      },
      {
        approvalId: 'approval-second-2',
        requestId: 'request-2',
        conversationKey: 'qqbot:group:approval-demo',
        threadId: 'thread-1',
        turnId: 'turn-2',
        itemId: 'item-2',
        kind: 'commandExecution',
        payloadJson: '{}',
        status: 'pending',
        createdAt: '2026-03-19T00:00:01.000Z',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:approval-demo', '/approve latest'), sink);
  assert.deepEqual(core.lastRespondApprovalParams, {
    approvalId: 'approval-latest-1',
    decision: 'accept',
  });

  await runtime.handleIncoming(buildMessage('qqbot:group:approval-demo', '/approve 2'), sink);
  assert.deepEqual(core.lastRespondApprovalParams, {
    approvalId: 'approval-second-2',
    decision: 'accept',
  });
});

test('approval request text advertises short approval tokens', async () => {
  const runtime = createRuntime();
  const { sink, messages } = createSink();

  runtime.attachHost({
    resolveSinkForConversation() {
      return sink;
    },
    listConversationChannels() {
      return [];
    },
  });

  await (runtime as any).handleApproval({
    eventId: 'evt-1',
    approvalId: 'approval-very-long-12345',
    conversationKey: 'qqbot:group:approval-demo',
    threadId: 'thread-1',
    turnId: 'turn-1',
    kind: 'commandExecution',
    reason: 'Need shell access',
    summary: 'Command execution approval requested',
    availableDecisions: ['accept', 'decline'],
    payloadJson: JSON.stringify({ command: 'cargo test' }),
  });

  const approvalMessage = messages.at(-1);
  assert.ok(approvalMessage);
  assert.match(approvalMessage.text, /需要确认：approval-ver/);
  assert.match(approvalMessage.text, /回复“同意”或“拒绝”即可/);
  assert.match(approvalMessage.text, /同意 1/);
  assert.match(approvalMessage.text, /同意 approval-ver/);
});

test('permission approvals are auto-approved when conversation setting is enabled', async () => {
  const core = new MockCoreClient();
  const runtime = createRuntime(core);
  const { sink, messages } = createSink();

  runtime.attachHost({
    resolveSinkForConversation() {
      return sink;
    },
    listConversationChannels() {
      return [];
    },
  });

  await runtime.handleIncoming(buildMessage('qqbot:group:auto-approval-demo', '/approveall on'), sink);
  core.respondApprovalCalls = [];

  await (runtime as any).handleApproval({
    eventId: 'evt-1',
    approvalId: 'permission-approval-1',
    conversationKey: 'qqbot:group:auto-approval-demo',
    threadId: 'thread-1',
    turnId: 'turn-1',
    kind: 'permissions',
    reason: 'Need network',
    summary: 'Permission approval requested',
    availableDecisions: ['accept', 'decline'],
    payloadJson: JSON.stringify({ permissions: { network: true } }),
  });

  assert.deepEqual(core.respondApprovalCalls, [
    {
      approvalId: 'permission-approval-1',
      decision: 'accept',
    },
  ]);
  assert.match(messages.at(-1)?.text ?? '', /Auto-approved permission request/);
});

test('natural language approve command resolves the only pending approval', async () => {
  const core = new MockCoreClient();
  core.statusResponse = {
    conversation: null,
    pendingApprovals: [
      {
        approvalId: 'approval-very-long-12345',
        requestId: 'request-1',
        conversationKey: 'qqbot:group:approval-demo',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        kind: 'commandExecution',
        payloadJson: '{}',
        status: 'pending',
        createdAt: '2026-03-19T00:00:00.000Z',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:approval-demo', '同意'), sink);

  assert.deepEqual(core.lastRespondApprovalParams, {
    approvalId: 'approval-very-long-12345',
    decision: 'accept',
  });
});

test('natural language reject command resolves approval by index', async () => {
  const core = new MockCoreClient();
  core.statusResponse = {
    conversation: null,
    pendingApprovals: [
      {
        approvalId: 'approval-first-1',
        requestId: 'request-1',
        conversationKey: 'qqbot:group:approval-demo',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        kind: 'commandExecution',
        payloadJson: '{}',
        status: 'pending',
        createdAt: '2026-03-19T00:00:00.000Z',
      },
      {
        approvalId: 'approval-second-2',
        requestId: 'request-2',
        conversationKey: 'qqbot:group:approval-demo',
        threadId: 'thread-1',
        turnId: 'turn-2',
        itemId: 'item-2',
        kind: 'commandExecution',
        payloadJson: '{}',
        status: 'pending',
        createdAt: '2026-03-19T00:00:01.000Z',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:approval-demo', '拒绝 2'), sink);

  assert.deepEqual(core.lastRespondApprovalParams, {
    approvalId: 'approval-second-2',
    decision: 'decline',
  });
});

test('natural language cancel maps to cancel decision', async () => {
  const core = new MockCoreClient();
  core.statusResponse = {
    conversation: null,
    pendingApprovals: [
      {
        approvalId: 'approval-very-long-12345',
        requestId: 'request-1',
        conversationKey: 'qqbot:group:approval-demo',
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        kind: 'commandExecution',
        payloadJson: '{}',
        status: 'pending',
        createdAt: '2026-03-19T00:00:00.000Z',
      },
    ],
  };
  const runtime = createRuntime(core);
  const { sink } = createSink();

  await runtime.handleIncoming(buildMessage('qqbot:group:approval-demo', '取消'), sink);

  assert.deepEqual(core.lastRespondApprovalParams, {
    approvalId: 'approval-very-long-12345',
    decision: 'cancel',
  });
});

function createRuntime(
  core = new MockCoreClient(),
  config = buildConfig(),
): QodexEdgeRuntime {
  return new QodexEdgeRuntime(
    core as any,
    createLogger('fatal'),
    config,
  );
}

function buildConfig(backendKind: QodexConfig['backend']['kind'] = 'codex'): QodexConfig {
  return {
    server: {
      bind: '127.0.0.1:7820',
    },
    edge: {
      coreUrl: 'ws://127.0.0.1:7820/ws',
      requestTimeoutMs: 30_000,
      streamFlushMs: 1_200,
      autoApprovePermissions: false,
    },
    logging: {
      rust: 'fatal',
      node: 'fatal',
    },
    backend: {
      kind: backendKind,
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

function buildMessage(
  conversationKey: string,
  text = 'hello from runtime test',
  images?: PlatformMessage['images'],
  backendKind?: PlatformMessage['backendKind'],
  files?: PlatformMessage['files'],
): PlatformMessage {
  return {
    conversation: {
      conversationKey,
      platform: 'qqbot',
      scope: 'group',
      externalId: conversationKey.split(':').at(-1) ?? 'demo',
    },
    sender: {
      senderId: 'tester',
      displayName: 'Tester',
    },
    text,
    images,
    backendKind,
    files,
  };
}

function createSink(options?: { showAcceptedAck?: boolean }): {
  sink: OutboundSink;
  messages: Array<{ kind: string; text: string }>;
} {
  const messages: Array<{ kind: string; text: string }> = [];
  return {
    sink: {
      showAcceptedAck: options?.showAcceptedAck,
      async sendText(message) {
        messages.push({
          kind: message.kind,
          text: message.text,
        });
      },
    },
    messages,
  };
}
