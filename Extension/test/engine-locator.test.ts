// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { findEngine, isPathInside, LOCAL_STATE_FILE_NAME } from '../src/shared/engine-locator.ts';

/** Creates a temporary folder tree for one test and returns its root. */
function makeTemporaryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verse-playground-test-'));
}

test('finds the local state file in a parent of the start folder', () => {
  const repositoryRoot = makeTemporaryRoot();
  const sampleFolder = path.join(repositoryRoot, 'Samples', 'HelloWorld');
  fs.mkdirSync(sampleFolder, { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, LOCAL_STATE_FILE_NAME), JSON.stringify({ engineDir: 'D:\\Engine' }));

  const engine = findEngine('', [sampleFolder]);
  assert.equal(engine?.location.engineDir, 'D:\\Engine');
  assert.equal(engine?.location.versePath, path.join('D:\\Engine', 'Engine', 'Binaries', 'Win64', 'verse.exe'));
});

test('prefers the configured engine folder over the local state file', () => {
  const repositoryRoot = makeTemporaryRoot();
  fs.writeFileSync(path.join(repositoryRoot, LOCAL_STATE_FILE_NAME), JSON.stringify({ engineDir: 'D:\\Engine' }));
  assert.equal(findEngine('  E:\\Other  ', [repositoryRoot])?.location.engineDir, 'E:\\Other');
});

test('skips a malformed local state file and keeps looking further up', () => {
  const repositoryRoot = makeTemporaryRoot();
  const innerFolder = path.join(repositoryRoot, 'Inner');
  fs.mkdirSync(innerFolder);
  fs.writeFileSync(path.join(innerFolder, LOCAL_STATE_FILE_NAME), 'not json');
  fs.writeFileSync(path.join(repositoryRoot, LOCAL_STATE_FILE_NAME), JSON.stringify({ engineDir: 'D:\\Engine' }));
  assert.equal(findEngine('', [innerFolder])?.location.engineDir, 'D:\\Engine');
});

test('reports the setting as the source when the engine folder is configured', () => {
  const repositoryRoot = makeTemporaryRoot();
  fs.writeFileSync(path.join(repositoryRoot, LOCAL_STATE_FILE_NAME), JSON.stringify({ engineDir: 'D:\\Engine' }));
  assert.deepEqual(findEngine('E:\\Other', [repositoryRoot])?.source, { kind: 'setting' });
});

test('reports the local state file that named the engine as the source', () => {
  const repositoryRoot = makeTemporaryRoot();
  const innerFolder = path.join(repositoryRoot, 'Inner');
  fs.mkdirSync(innerFolder);
  fs.writeFileSync(path.join(innerFolder, LOCAL_STATE_FILE_NAME), 'not json');
  const stateFilePath = path.join(repositoryRoot, LOCAL_STATE_FILE_NAME);
  fs.writeFileSync(stateFilePath, JSON.stringify({ engineDir: 'D:\\Engine' }));
  assert.deepEqual(findEngine('', [innerFolder])?.source, { kind: 'localState', stateFilePath });
});

test('returns undefined when nothing is found', () => {
  assert.equal(findEngine('', [makeTemporaryRoot()]), undefined);
});

test('treats paths inside a folder, in any letter case, as inside it', () => {
  assert.equal(isPathInside('C:\\Repo\\UnrealEngine\\Engine\\A.verse', 'c:\\repo\\unrealengine'), true);
  assert.equal(isPathInside('C:\\Repo\\UnrealEngine', 'C:\\Repo\\UnrealEngine'), true);
  assert.equal(isPathInside('C:\\Repo\\Samples\\A.verse', 'C:\\Repo\\UnrealEngine'), false);
  assert.equal(isPathInside('C:\\Repo\\UnrealEngineOther\\A.verse', 'C:\\Repo\\UnrealEngine'), false);
});
