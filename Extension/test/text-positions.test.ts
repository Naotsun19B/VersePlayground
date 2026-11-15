// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { splitLines, toUtf16Column, toUtf8ByteColumn } from '../src/server/text-positions.ts';

/** A line mixing ASCII and Japanese text, with an undefined identifier at the end. */
const JAPANESE_LINE = 'Print("日本語"); Print(Undefined)';

test('ASCII columns are the same in both units', () => {
  assert.equal(toUtf8ByteColumn('Print(X)', 6), 6);
  assert.equal(toUtf16Column('Print(X)', 6), 6);
});

test('a Japanese character is one UTF-16 unit and three bytes', () => {
  // Print(" is 7 units, 日本語 is 3 units / 9 bytes, then "); Print( is 10 units.
  assert.equal(toUtf8ByteColumn(JAPANESE_LINE, 7), 7);
  assert.equal(toUtf8ByteColumn(JAPANESE_LINE, 10), 16);
  assert.equal(toUtf16Column(JAPANESE_LINE, 16), 10);

  const undefinedStart = JAPANESE_LINE.indexOf('Undefined');
  const undefinedByteStart = toUtf8ByteColumn(JAPANESE_LINE, undefinedStart);
  assert.equal(undefinedByteStart, undefinedStart + 6);
  assert.equal(toUtf8ByteColumn(JAPANESE_LINE, undefinedStart + 9) - undefinedByteStart, 9);
  assert.equal(toUtf16Column(JAPANESE_LINE, undefinedByteStart), undefinedStart);
});

test('an emoji is a surrogate pair of two UTF-16 units and four bytes', () => {
  const line = 'a😀b';
  assert.equal(line.length, 4);
  assert.equal(toUtf8ByteColumn(line, 1), 1);
  assert.equal(toUtf8ByteColumn(line, 3), 5);
  assert.equal(toUtf8ByteColumn(line, 4), 6);
  assert.equal(toUtf16Column(line, 1), 1);
  assert.equal(toUtf16Column(line, 5), 3);
  assert.equal(toUtf16Column(line, 6), 4);
});

test('a column in the middle of a surrogate pair counts as the start of the pair', () => {
  assert.equal(toUtf8ByteColumn('a😀b', 2), 1);
});

test('a byte offset in the middle of a character counts as the start of the character', () => {
  assert.equal(toUtf16Column('あい', 1), 0);
  assert.equal(toUtf16Column('あい', 4), 1);
  assert.equal(toUtf16Column('a😀b', 3), 1);
});

test('a lone surrogate takes three bytes like the replacement character', () => {
  const line = `a${String.fromCharCode(0xd800)}b`;
  assert.equal(toUtf8ByteColumn(line, 2), 4);
  assert.equal(toUtf16Column(line, 4), 2);
});

test('tabs are one unit and one byte', () => {
  assert.equal(toUtf8ByteColumn('\t\tX', 2), 2);
  assert.equal(toUtf16Column('\t\tあ', 2), 2);
  assert.equal(toUtf16Column('\t\tあ', 5), 3);
});

test('a column past the end of the line is clamped to the end', () => {
  assert.equal(toUtf8ByteColumn('あい', 99), 6);
  assert.equal(toUtf16Column('あい', 99), 2);
  assert.equal(toUtf8ByteColumn('', 5), 0);
  assert.equal(toUtf16Column('', 5), 0);
});

test('a negative column is clamped to the start', () => {
  assert.equal(toUtf8ByteColumn('abc', -3), 0);
  assert.equal(toUtf16Column('abc', -3), 0);
});

test('a line terminator that the caller kept is not counted', () => {
  assert.equal(toUtf8ByteColumn('あい\r\n', 99), 6);
  assert.equal(toUtf16Column('あい\r\n', 99), 2);
  assert.equal(toUtf8ByteColumn('abc\n', 4), 3);
  assert.equal(toUtf16Column('abc\r', 4), 3);
});

test('splitLines handles CRLF, LF and CR and keeps empty lines', () => {
  assert.deepEqual(splitLines('a\r\nb\nc\rd'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitLines('a\r\n\r\nb'), ['a', '', 'b']);
  assert.deepEqual(splitLines(''), ['']);
  assert.deepEqual(splitLines('a\n'), ['a', '']);
});

test('a CRLF line converts like the same line without the terminator', () => {
  const [firstLine] = splitLines('Print("あ"); Print(Nope)\r\nNext');
  // Print(" is 7 bytes, あ is 3, and "); Print( is 10 more.
  assert.equal(firstLine.indexOf('Nope'), 18);
  assert.equal(toUtf8ByteColumn(firstLine, 18), 20);
  assert.equal(toUtf16Column(firstLine, 20), 18);
});

test('converting to bytes and back returns the same column at every character boundary', () => {
  const line = '\tPrint("日本語😀"); # テスト';
  let utf16Column = 0;
  while (utf16Column <= line.length) {
    assert.equal(toUtf16Column(line, toUtf8ByteColumn(line, utf16Column)), utf16Column);
    const codePoint = line.codePointAt(utf16Column);
    utf16Column += (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
  }
});
