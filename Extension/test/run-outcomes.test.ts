// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseResponse, PROTOCOL_VERSION } from '../src/server/ide-protocol.ts';
import { describeFailure, toCheckOutcome, toPingResult } from '../src/server/run-outcomes.ts';

/** The validated answer of a ping, as the runner hands it over. */
const PING_ANSWER = { protocol: PROTOCOL_VERSION, diagnostics: [], hover: null, definition: null };

test('a ping that verse.exe answered is read back by the registry as ok', () => {
  const pingResult = toPingResult({ status: 'ok', response: PING_ANSWER });
  assert.equal(pingResult.kind, 'answered');
  if (pingResult.kind !== 'answered') {
    return;
  }

  assert.equal(parseResponse(pingResult.responseJson).status, 'ok');
});

test('a ping in another protocol is read back as a protocol mismatch', () => {
  const pingResult = toPingResult({ status: 'protocolMismatch', protocol: PROTOCOL_VERSION + 1 });
  assert.equal(pingResult.kind, 'answered');
  if (pingResult.kind !== 'answered') {
    return;
  }

  assert.equal(parseResponse(pingResult.responseJson).status, 'protocolMismatch');
});

test('only an exit code of 1 without an answer counts as an exe without the analysis mode', () => {
  assert.deepEqual(
    toPingResult({ status: 'noResponse', exitCode: 1, stderr: '', stdinError: undefined }),
    { kind: 'noAnswer', exitCode: 1 },
  );
  assert.equal(toPingResult({ status: 'noResponse', exitCode: 2, stderr: '', stdinError: undefined }).kind, 'failed');
});

test('a check that verse.exe refused becomes a failed outcome with the reason', () => {
  const checkOutcome = toCheckOutcome({ status: 'rejected', error: 'The request has no "folder" string.' });
  assert.equal(checkOutcome.isOk, false);
  assert.match(describeFailure({ status: 'rejected', error: 'no folder' }), /refused the request: no folder/);
});
