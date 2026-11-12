// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isConstructorWrapperFrame, toClientStackTrace } from '../src/debug-frames.ts';

const SAMPLE_PATH = 'F:/Projects/VersePlayground/Samples/Random/Random.verse';

test('recognizes the wrapper of a constructor function by its name', () => {
  assert.equal(isConstructorWrapperFrame({ id: 1, name: 'MakeRandomGenerator_BodyWrapper', line: 48, column: 0 }), true);
  assert.equal(isConstructorWrapperFrame({ id: 2, name: 'MakeRandomGenerator', line: 48, column: 0 }), false);
});

test('leaves the wrapper of a constructor function out of the call stack', () => {
  const clientBody = toClientStackTrace({
    stackFrames: [
      { id: 1, name: 'MakeRandomGenerator', line: 49, column: 0, source: { path: SAMPLE_PATH } },
      { id: 2, name: 'MakeRandomGenerator_BodyWrapper', line: 48, column: 0, source: { path: SAMPLE_PATH } },
      { id: 3, name: 'Main(:[][]char,:[[]char][]char)', line: 53, column: 0, source: { path: SAMPLE_PATH } },
    ],
  });
  const frameNames = clientBody.stackFrames.map((clientFrame) => clientFrame.name);
  assert.deepEqual(frameNames, ['MakeRandomGenerator', 'Main(:[][]char,:[[]char][]char)']);
  assert.equal(clientBody.totalFrames, 2);
});

test('dims runtime helpers and starts unknown columns at 1', () => {
  const clientBody = toClientStackTrace({
    stackFrames: [
      { id: 1, name: 'Main', line: 3, column: 0, source: { path: SAMPLE_PATH } },
      { id: 2, name: '__SpawnReturnImpl__', line: 0, column: 0, source: { path: '__SpawnReturnImpl__' } },
    ],
  });
  assert.deepEqual(clientBody.stackFrames.map((clientFrame) => clientFrame.presentationHint), ['normal', 'subtle']);
  assert.equal(clientBody.stackFrames[0]?.column, 1);
  assert.equal(clientBody.stackFrames[0]?.source?.name, 'Random.verse');
  assert.equal(clientBody.stackFrames[1]?.source, undefined);
});

test('returns no frames when the body has none', () => {
  assert.deepEqual(toClientStackTrace({}), { stackFrames: [], totalFrames: 0 });
});
