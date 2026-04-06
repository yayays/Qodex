import assert from 'node:assert/strict';
import test from 'node:test';

import { CLI_COMMAND_SUMMARY } from '../src/cli-output.js';

test('CLI command summary includes autocontinue', () => {
  assert.match(CLI_COMMAND_SUMMARY, /\/autocontinue \[on\|off\|status\]/);
});

test('CLI command summary includes restart', () => {
  assert.match(CLI_COMMAND_SUMMARY, /\/restart/);
});
