// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitArguments } from '../src/command-line.ts';

test('splits on any run of whitespace', () => {
  assert.deepEqual(splitArguments('  one two\tthree  '), ['one', 'two', 'three']);
});

test('keeps quoted text with spaces as one argument', () => {
  assert.deepEqual(splitArguments('greet "Ada Lovelace" now'), ['greet', 'Ada Lovelace', 'now']);
});

test('keeps an empty pair of quotes as an empty argument', () => {
  assert.deepEqual(splitArguments('a "" b'), ['a', '', 'b']);
});

test('keeps backslashes in Windows paths and unescapes quotes', () => {
  assert.deepEqual(splitArguments('C:\\Data\\in.txt say\\"hi\\"'), ['C:\\Data\\in.txt', 'say"hi"']);
});

test('returns nothing for an empty line', () => {
  assert.deepEqual(splitArguments('   '), []);
});
