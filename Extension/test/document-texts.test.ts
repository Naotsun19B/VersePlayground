// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DocumentTexts, readTextFile } from '../src/server/document-texts.ts';

test('an open document wins over the file on disk', () => {
  const texts = new DocumentTexts(
    (filePath) => (filePath === 'A.verse' ? 'open one\nopen two' : undefined),
    () => 'disk one',
  );
  assert.deepEqual(texts.getLines('A.verse'), ['open one', 'open two']);
});

test('an open document with empty text is still the open document', () => {
  const texts = new DocumentTexts(() => '', () => 'disk text');
  assert.deepEqual(texts.getLines('A.verse'), ['']);
});

test('a file that is not open is read from disk', () => {
  const texts = new DocumentTexts(() => undefined, () => 'first\r\nsecond');
  assert.equal(texts.getLineText('B.verse', 1), 'second');
});

test('a file that can be read from neither is unavailable', () => {
  const texts = new DocumentTexts(() => undefined, () => undefined);
  assert.equal(texts.getLines('C.verse'), undefined);
  assert.equal(texts.getLineText('C.verse', 0), undefined);
});

test('a line past the end of the file is unavailable', () => {
  const texts = new DocumentTexts(() => 'only line', () => undefined);
  assert.equal(texts.getLineText('A.verse', 0), 'only line');
  assert.equal(texts.getLineText('A.verse', 5), undefined);
});

test('a file is read once, even when it cannot be read', () => {
  let readCount = 0;
  const texts = new DocumentTexts(() => undefined, (filePath) => {
    readCount += 1;
    return (filePath === 'Good.verse' ? 'text' : undefined);
  });
  texts.getLines('Good.verse');
  texts.getLineText('Good.verse', 0);
  texts.getLines('Bad.verse');
  texts.getLines('Bad.verse');
  assert.equal(readCount, 2);
});

test('readTextFile reads UTF-8 from disk and returns undefined for a missing file', () => {
  const folder = mkdtempSync(join(tmpdir(), 'document-texts-'));
  try {
    const filePath = join(folder, 'Main.verse');
    writeFileSync(filePath, 'Print("日本語")', 'utf8');
    assert.equal(readTextFile(filePath), 'Print("日本語")');
    assert.equal(readTextFile(join(folder, 'Missing.verse')), undefined);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('readTextFile leaves out the UTF-8 byte order mark, as the editor and verse.exe do', () => {
  const folder = mkdtempSync(join(tmpdir(), 'document-texts-'));
  try {
    const filePath = join(folder, 'Main.verse');
    writeFileSync(filePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Print(Undefined)', 'utf8')]));
    assert.equal(readTextFile(filePath), 'Print(Undefined)');
    assert.equal(new DocumentTexts(() => undefined).getLineText(filePath, 0), 'Print(Undefined)');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
