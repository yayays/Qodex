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

test('formatPrettyLogLine renders nested fields across multiple lines', () => {
  const output = formatPrettyLogLine({
    level: 30,
    time: 1774527557278,
    name: 'qodex-edge',
    instanceId: 'qq_fourth',
    channelId: 'qqbot',
    msg: 'channel status updated: connected via websocket',
    connection: {
      connected: true,
      mode: 'websocket',
    },
    session: {
      sessionId: 'session-1',
      lastSeq: 13,
    },
  });

  assert.match(output, /INFO/);
  assert.match(output, /channel status updated: connected via websocket/);
  assert.match(output, /\n  connection:/);
  assert.match(output, /\n    connected: true/);
  assert.match(output, /\n  session:/);
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
