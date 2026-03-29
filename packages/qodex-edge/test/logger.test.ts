import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import {
  createLogger,
  formatPrettyLogLine,
  resolveLogFormat,
} from '../src/logger.js';

test('resolveLogFormat defaults to pretty for interactive terminals', () => {
  assert.equal(
    resolveLogFormat({
      env: {},
      isTTY: true,
    }),
    'pretty',
  );
});

test('resolveLogFormat defaults to json for non-interactive output', () => {
  assert.equal(
    resolveLogFormat({
      env: {},
      isTTY: false,
    }),
    'json',
  );
});

test('resolveLogFormat honors explicit env override', () => {
  assert.equal(
    resolveLogFormat({
      env: { QODEX_LOG_FORMAT: 'json' },
      isTTY: true,
    }),
    'json',
  );
  assert.equal(
    resolveLogFormat({
      env: { QODEX_LOG_FORMAT: 'pretty' },
      isTTY: false,
    }),
    'pretty',
  );
});

test('formatPrettyLogLine renders ordinary nested fields across multiple lines', () => {
  const output = formatPrettyLogLine({
    level: 30,
    time: 1774527557278,
    name: 'qodex-edge',
    instanceId: 'qq_fourth',
    channelId: 'qqbot',
    msg: 'wechat compat skipped unsupported inbound message',
    message: {
      from_user_id: 'user-1',
      message_type: 1,
    },
  });

  assert.match(output, /INFO/);
  assert.match(output, /wechat compat skipped unsupported inbound message/);
  assert.match(output, /\n  message:/);
  assert.match(output, /\n    from_user_id: user-1/);
  assert.match(output, /\n    message_type: 1/);
});

test('formatPrettyLogLine renders channel status updates on one line', () => {
  const output = formatPrettyLogLine({
    level: 30,
    time: 1774527557278,
    name: 'qodex-edge',
    instanceId: 'qq_fourth',
    channelId: 'qqbot',
    accountId: 'fourth-account',
    msg: 'channel status updated: connected via websocket',
    connection: {
      connected: true,
      mode: 'websocket',
    },
    gateway: {
      url: 'wss://api.sgroup.qq.com/websocket',
      intent: 1107300352,
    },
    session: {
      sessionId: 'session-1',
      lastSeq: 13,
    },
  });

  const trimmed = output.trimEnd();
  assert.match(trimmed, /channel status updated: connected via websocket/);
  assert.equal(trimmed.split('\n').length, 1);
  assert.doesNotMatch(trimmed, /instanceId=/);
  assert.doesNotMatch(trimmed, /channelId=/);
  assert.doesNotMatch(trimmed, /accountId=/);
  assert.match(trimmed, /connected=true/);
  assert.match(trimmed, /mode=websocket/);
  assert.match(trimmed, /gateway=wss:\/\/api\.sgroup\.qq\.com\/websocket/);
  assert.match(trimmed, /gatewayIntent=1107300352/);
  assert.match(trimmed, /sessionId=session-1/);
  assert.match(trimmed, /lastSeq=13/);
});

test('createLogger uses pretty output when selected', async () => {
  let written = '';
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      written += chunk.toString();
      callback();
    },
  });
  const logger = createLogger('info', {
    format: 'pretty',
    destination,
  });

  logger.info({ instanceId: 'qq_fourth', channelId: 'qqbot' }, 'channel status updated');
  await new Promise((resolve) => setImmediate(resolve));

  assert.doesNotMatch(written, /^\{/m);
  assert.match(written, /INFO/);
  assert.match(written, /channel status updated/);
});
