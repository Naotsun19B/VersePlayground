// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeHandshake, encodeMessage, MessageReader } from '../src/debug-wire.ts';

test('prefixes a message with its byte length in big-endian order', () => {
  const encodedMessage = encodeMessage({ type: 'threads' });
  const jsonText = '{"type":"threads"}';
  assert.equal(encodedMessage.readUInt32BE(0), Buffer.byteLength(jsonText));
  assert.equal(encodedMessage.subarray(4).toString('utf8'), jsonText);
});

test('counts the length in bytes, not characters, for non-ASCII text', () => {
  const encodedMessage = encodeMessage({ value: 'あ' });
  assert.equal(encodedMessage.readUInt32BE(0), encodedMessage.length - 4);
});

test('sends the next breakpoint id before the first breakpoints', () => {
  const handshake = encodeHandshake([{ source: { path: 'C:\\A.verse' }, id: 0, line: 5 }], 3);
  assert.equal(handshake.readUInt32BE(0), 3);

  const reader = new MessageReader();
  assert.deepEqual(reader.push(handshake.subarray(4)), [[{ source: { path: 'C:\\A.verse' }, id: 0, line: 5 }]]);
});

test('reassembles messages that arrive split and joined arbitrarily', () => {
  const stream = Buffer.concat([encodeMessage({ first: 1 }), encodeMessage({ second: 2 })]);
  const reader = new MessageReader();
  const receivedMessages: unknown[] = [];
  for (let byteIndex = 0; byteIndex < stream.length; byteIndex += 3) {
    receivedMessages.push(...reader.push(stream.subarray(byteIndex, byteIndex + 3)));
  }
  assert.deepEqual(receivedMessages, [{ first: 1 }, { second: 2 }]);
});

test('refuses a length too large to be a real message', () => {
  const garbage = Buffer.alloc(4);
  garbage.writeUInt32BE(0xffffffff, 0);
  assert.throws(() => new MessageReader().push(garbage), /too large/);
});
