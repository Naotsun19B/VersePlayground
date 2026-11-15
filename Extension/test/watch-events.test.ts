// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { FileChangeType, type FileEvent } from 'vscode-languageserver/node';

import { planWatchedFileChanges, toFilePath } from '../src/server/watch-events.ts';
import { toComparisonKey } from '../src/shared/program-paths.ts';

/** Builds a file event for a path. */
function event(filePath: string, type: FileChangeType): FileEvent {
  return { uri: pathToFileURL(filePath).href, type };
}

/** Compares folders the way the server does, so that the test does not depend on the spelling of the drive letter. */
function toKeys(folders: readonly string[]): string[] {
  return folders.map((folder) => toComparisonKey(folder));
}

const NOTHING_OPEN = (): boolean => false;

/** Every kind of change a file event can report. */
const ALL_CHANGE_TYPES: readonly FileChangeType[] = [
  FileChangeType.Created,
  FileChangeType.Changed,
  FileChangeType.Deleted,
];

test('creating, changing and deleting a .verse file lead to its folder', () => {
  for (const type of ALL_CHANGE_TYPES) {
    const plan = planWatchedFileChanges([event('C:\\Code\\Proj\\Main.verse', type)], NOTHING_OPEN);
    assert.equal(plan.isLocalStateChanged, false);
    assert.deepEqual(toKeys(plan.changedFolders), [toComparisonKey('C:/Code/Proj')]);
  }
});

test('saving a document that is open is ignored, because the analysis uses the editor text', () => {
  const plan = planWatchedFileChanges([event('C:\\Code\\Proj\\Main.verse', FileChangeType.Changed)], () => true);
  assert.deepEqual(plan, { isLocalStateChanged: false, changedFolders: [] });
});

test('creating or deleting a file that is open still leads to its folder', () => {
  const created = planWatchedFileChanges([event('C:\\Code\\Proj\\Main.verse', FileChangeType.Created)], () => true);
  const deleted = planWatchedFileChanges([event('C:\\Code\\Proj\\Main.verse', FileChangeType.Deleted)], () => true);
  assert.equal(created.changedFolders.length, 1);
  assert.equal(deleted.changedFolders.length, 1);
});

test('the open check receives the path of the file', () => {
  const asked: string[] = [];
  planWatchedFileChanges([event('C:\\Code\\Proj\\Main.verse', FileChangeType.Changed)], (filePath) => {
    asked.push(filePath);
    return false;
  });
  assert.deepEqual(asked.map((filePath) => toComparisonKey(filePath)), [toComparisonKey('C:/Code/Proj/Main.verse')]);
});

test('files that are not .verse files are ignored', () => {
  const plan = planWatchedFileChanges([event('C:\\Code\\Proj\\Notes.txt', FileChangeType.Changed)], NOTHING_OPEN);
  assert.deepEqual(plan, { isLocalStateChanged: false, changedFolders: [] });
});

test('events of other URI schemes are ignored', () => {
  const plan = planWatchedFileChanges(
    [{ uri: 'untitled:Untitled-1.verse', type: FileChangeType.Created }],
    NOTHING_OPEN,
  );
  assert.deepEqual(plan, { isLocalStateChanged: false, changedFolders: [] });
});

test('several files of one folder lead to the folder once, in any spelling', () => {
  const plan = planWatchedFileChanges(
    [
      event('C:\\Code\\Proj\\A.verse', FileChangeType.Created),
      event('c:\\code\\PROJ\\B.verse', FileChangeType.Deleted),
      event('C:\\Code\\Other\\C.verse', FileChangeType.Created),
    ],
    NOTHING_OPEN,
  );
  assert.deepEqual(toKeys(plan.changedFolders), [toComparisonKey('C:/Code/Proj'), toComparisonKey('C:/Code/Other')]);
});

test('creating, changing and deleting the local state file are reported, in any case', () => {
  for (const type of ALL_CHANGE_TYPES) {
    const plan = planWatchedFileChanges([event('C:\\Code\\Proj\\VersePlayground.local.json', type)], () => true);
    assert.deepEqual(plan, { isLocalStateChanged: true, changedFolders: [] });
  }

  const upperCasePlan = planWatchedFileChanges(
    [event('C:\\Code\\Proj\\VERSEPLAYGROUND.LOCAL.JSON', FileChangeType.Changed)],
    NOTHING_OPEN,
  );
  assert.equal(upperCasePlan.isLocalStateChanged, true);
});

test('a local state file outside every workspace folder is reported too', () => {
  const plan = planWatchedFileChanges(
    [event('D:\\Elsewhere\\VersePlayground.local.json', FileChangeType.Changed)],
    NOTHING_OPEN,
  );
  assert.equal(plan.isLocalStateChanged, true);
});

test('a local state file and a .verse file in one batch are both acted on', () => {
  const plan = planWatchedFileChanges(
    [
      event('C:\\Code\\Proj\\VersePlayground.local.json', FileChangeType.Changed),
      event('C:\\Code\\Proj\\Main.verse', FileChangeType.Created),
    ],
    NOTHING_OPEN,
  );
  assert.equal(plan.isLocalStateChanged, true);
  assert.equal(plan.changedFolders.length, 1);
});

test('only file URIs have a path', () => {
  assert.equal(toFilePath('untitled:Untitled-1'), undefined);
  assert.equal(toFilePath('vscode-notebook-cell:/a.verse'), undefined);
  const filePath = toFilePath(pathToFileURL('C:\\Code\\A.verse').href) ?? '';
  assert.equal(toComparisonKey(filePath), toComparisonKey('C:/Code/A.verse'));
});
