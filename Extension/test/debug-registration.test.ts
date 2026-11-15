// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ProgramDocument } from '../src/program-documents.ts';
import {
  resolveProgramPath,
  saveAllDocuments,
  selectUnsavedProgramDocuments,
} from '../src/program-documents.ts';

/** Builds a document with the parts the selection looks at. */
function createDocument(fsPath: string, isDirty: boolean, scheme: string = 'file'): ProgramDocument {
  return { uri: { fsPath, scheme }, isDirty };
}

test('selectUnsavedProgramDocuments picks the unsaved Verse files of the program folder', () => {
  const main = createDocument('C:\\Code\\One\\Main.verse', true);
  const sibling = createDocument('c:/code/one/Helper.VERSE', true);
  const saved = createDocument('C:\\Code\\One\\Saved.verse', false);
  const subfolder = createDocument('C:\\Code\\One\\Sub\\Deep.verse', true);
  const otherFolder = createDocument('C:\\Code\\Two\\Other.verse', true);
  const notVerse = createDocument('C:\\Code\\One\\Notes.txt', true);
  const untitled = createDocument('Untitled-1.verse', true, 'untitled');

  const selected = selectUnsavedProgramDocuments(
    [main, sibling, saved, subfolder, otherFolder, notVerse, untitled],
    'C:\\Code\\One\\Main.verse',
  );

  assert.deepEqual(selected, [main, sibling]);
});

test('selectUnsavedProgramDocuments returns nothing when every file is saved', () => {
  const saved = createDocument('C:\\Code\\One\\Main.verse', false);
  assert.deepEqual(selectUnsavedProgramDocuments([saved], 'C:\\Code\\One\\Main.verse'), []);
});

test('saveAllDocuments saves every document and reports success', async () => {
  const savedNames: string[] = [];
  const isSaved = await saveAllDocuments(['a', 'b', 'c'], async (name) => {
    savedNames.push(name);
    return true;
  });

  assert.equal(isSaved, true);
  assert.deepEqual(savedNames, ['a', 'b', 'c']);
});

test('saveAllDocuments stops at the first document that cannot be saved', async () => {
  const savedNames: string[] = [];
  const isSaved = await saveAllDocuments(['a', 'b', 'c'], async (name) => {
    savedNames.push(name);
    return name !== 'b';
  });

  assert.equal(isSaved, false);
  assert.deepEqual(savedNames, ['a', 'b']);
});

test('saveAllDocuments succeeds with nothing to save', async () => {
  assert.equal(await saveAllDocuments([], async () => false), true);
});

test('resolveProgramPath keeps an absolute path', () => {
  assert.equal(resolveProgramPath('C:\\Code\\One\\Main.verse', undefined), 'C:\\Code\\One\\Main.verse');
  assert.equal(resolveProgramPath('C:\\Code\\One\\Main.verse', 'C:\\Other'), 'C:\\Code\\One\\Main.verse');
});

test('resolveProgramPath resolves a relative path against the workspace folder', () => {
  assert.equal(resolveProgramPath('One\\Main.verse', 'C:\\Code'), 'C:\\Code\\One\\Main.verse');
  assert.equal(resolveProgramPath('.\\Main.verse', 'C:\\Code\\One'), 'C:\\Code\\One\\Main.verse');
});

test('resolveProgramPath returns undefined without a base folder for a relative path', () => {
  assert.equal(resolveProgramPath('Main.verse', undefined), undefined);
});

test('resolveProgramPath returns undefined when program is not a usable string', () => {
  assert.equal(resolveProgramPath(undefined, 'C:\\Code'), undefined);
  assert.equal(resolveProgramPath('  ', 'C:\\Code'), undefined);
  assert.equal(resolveProgramPath(42, 'C:\\Code'), undefined);
});
