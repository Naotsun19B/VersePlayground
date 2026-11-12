// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getArgumentLines, MAX_ARGUMENT_LINES_PER_FILE, recordArgumentLine } from '../src/argument-history.ts';
import type { ArgumentHistory } from '../src/argument-history.ts';

test('puts the newest line first', () => {
  const firstHistory = recordArgumentLine({}, 'C:\\Samples\\Hello.verse', 'one');
  const secondHistory = recordArgumentLine(firstHistory, 'C:\\Samples\\Hello.verse', 'two');
  assert.deepEqual(getArgumentLines(secondHistory, 'C:\\Samples\\Hello.verse'), ['two', 'one']);
});

test('moves a line that is used again to the front instead of repeating it', () => {
  let history = recordArgumentLine({}, 'C:\\Hello.verse', 'one');
  history = recordArgumentLine(history, 'C:\\Hello.verse', 'two');
  history = recordArgumentLine(history, 'C:\\Hello.verse', 'one');
  assert.deepEqual(getArgumentLines(history, 'C:\\Hello.verse'), ['one', 'two']);
});

test('keeps a separate history for each file, ignoring the case of the path', () => {
  let history = recordArgumentLine({}, 'C:\\Hello.verse', 'hello');
  history = recordArgumentLine(history, 'C:\\Greeting.verse', 'greeting');
  assert.deepEqual(getArgumentLines(history, 'c:\\hello.VERSE'), ['hello']);
  assert.deepEqual(getArgumentLines(history, 'C:\\Greeting.verse'), ['greeting']);
});

test('does not record a blank line', () => {
  const history = recordArgumentLine({}, 'C:\\Hello.verse', '   ');
  assert.deepEqual(getArgumentLines(history, 'C:\\Hello.verse'), []);
});

test('drops the oldest lines past the limit', () => {
  let history: ArgumentHistory = {};
  for (let lineNumber = 0; lineNumber <= MAX_ARGUMENT_LINES_PER_FILE; lineNumber++) {
    history = recordArgumentLine(history, 'C:\\Hello.verse', `line ${lineNumber}`);
  }

  const lines = getArgumentLines(history, 'C:\\Hello.verse');
  assert.equal(lines.length, MAX_ARGUMENT_LINES_PER_FILE);
  assert.equal(lines[0], `line ${MAX_ARGUMENT_LINES_PER_FILE}`);
  assert.equal(lines.at(-1), 'line 1');
});
