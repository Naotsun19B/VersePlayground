// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getFileName,
  getProgramFolder,
  isInsideEngine,
  isInsideFolder,
  isInSameProgram,
  isSamePath,
  isVerseFile,
  normalizePath,
  toComparisonKey,
  toDebuggerPath,
} from '../src/shared/program-paths.ts';

test('normalizePath uses slashes and drops trailing separators but keeps a root', () => {
  assert.equal(normalizePath('C:\\Code\\One\\Main.verse'), 'C:/Code/One/Main.verse');
  assert.equal(normalizePath('C:\\Code\\One\\'), 'C:/Code/One');
  assert.equal(normalizePath('C:\\Code/One'), 'C:/Code/One');
  assert.equal(normalizePath('C:'), 'C:/');
  assert.equal(normalizePath('C:\\'), 'C:/');
  assert.equal(normalizePath('/'), '/');
});

test('toComparisonKey ignores separators, trailing separators and case, including the drive letter', () => {
  assert.equal(toComparisonKey('C:\\Code\\One\\Main.verse'), 'c:/code/one/main.verse');
  assert.equal(toComparisonKey('c:/CODE/one/'), 'c:/code/one');
  assert.equal(toComparisonKey('C:\\Code\\One'), toComparisonKey('c:/code/ONE/'));
});

test('isSamePath compares by key', () => {
  assert.equal(isSamePath('C:\\Code\\A.verse', 'c:/code/a.verse'), true);
  assert.equal(isSamePath('C:\\Code\\A.verse', 'C:\\Code\\B.verse'), false);
});

test('getFileName returns the part after the last separator of either kind', () => {
  assert.equal(getFileName('C:\\Code/One\\Main.verse'), 'Main.verse');
  assert.equal(getFileName('Main.verse'), 'Main.verse');
});

test('isVerseFile checks the extension without case', () => {
  assert.equal(isVerseFile('C:/Code/Main.verse'), true);
  assert.equal(isVerseFile('C:/Code/Main.VERSE'), true);
  assert.equal(isVerseFile('C:/Code/Main.verse.txt'), false);
  assert.equal(isVerseFile('C:/Code/.verse/Main.txt'), false);
});

test('getProgramFolder is the folder of the file and nothing above or below it', () => {
  assert.equal(getProgramFolder('C:\\Users\\x\\Proj\\Main.verse'), 'C:/Users/x/Proj');
  assert.equal(getProgramFolder('C:/Users/x/Proj/Sub/Util.verse'), 'C:/Users/x/Proj/Sub');
});

test('getProgramFolder keeps the trailing slash of a drive root and handles paths without a folder', () => {
  assert.equal(getProgramFolder('C:\\Main.verse'), 'C:/');
  assert.equal(getProgramFolder('/Main.verse'), '/');
  assert.equal(getProgramFolder('Main.verse'), '');
});

test('getProgramFolder works with a Japanese folder name', () => {
  assert.equal(getProgramFolder('C:\\プロジェクト\\テスト\\Main.verse'), 'C:/プロジェクト/テスト');
});

test('isInSameProgram is true only for files directly in the same folder', () => {
  assert.equal(isInSameProgram('C:\\Code\\A.verse', 'c:/code/B.verse'), true);
  assert.equal(isInSameProgram('C:\\Code\\A.verse', 'C:\\Code\\Sub\\B.verse'), false);
  assert.equal(isInSameProgram('C:\\Code\\A.verse', 'D:\\Code\\A.verse'), false);
});

test('isInsideFolder accepts the folder itself and anything below it, but not a sibling with the same prefix', () => {
  assert.equal(isInsideFolder('C:\\Engine\\Source\\Main.verse', 'C:\\Engine'), true);
  assert.equal(isInsideFolder('c:/engine', 'C:\\Engine\\'), true);
  assert.equal(isInsideFolder('C:\\EngineCopy\\Main.verse', 'C:\\Engine'), false);
  assert.equal(isInsideFolder('C:\\Other\\Main.verse', 'C:\\Engine'), false);
  assert.equal(isInsideFolder('C:\\Code\\Main.verse', 'C:\\'), true);
});

test('isInsideEngine excludes files of the engine checkout and nothing else', () => {
  const engineDir = 'F:\\Projects\\VersePlayground\\UnrealEngine';
  const enginePluginFile = 'F:\\Projects\\VersePlayground\\UnrealEngine\\Engine\\Plugins\\A.verse';
  const lowerCaseEngineFile = 'f:/projects/verseplayground/unrealengine/Engine/A.verse';
  const sampleFile = 'F:\\Projects\\VersePlayground\\Samples\\HelloWorld\\Main.verse';
  assert.equal(isInsideEngine(enginePluginFile, engineDir), true);
  assert.equal(isInsideEngine(lowerCaseEngineFile, engineDir), true);
  assert.equal(isInsideEngine(sampleFile, engineDir), false);
});

test('isInsideEngine is false when no engine is known', () => {
  assert.equal(isInsideEngine('C:\\Code\\Main.verse', undefined), false);
  assert.equal(isInsideEngine('C:\\Code\\Main.verse', ''), false);
});

/** Lists a folder with these names whatever the folder is. */
function listing(...fileNames: string[]): () => readonly string[] {
  return () => fileNames;
}

test('toDebuggerPath returns the program file exactly as it was passed to verse.exe', () => {
  const programPath = 'C:\\Code\\Proj\\Main.verse';
  assert.equal(toDebuggerPath('c:/code/proj/main.verse', programPath, listing('Main.verse')), programPath);
});

test('toDebuggerPath keeps the program folder spelling and uses the on-disk file name for a sibling', () => {
  const programPath = 'C:\\Code\\Proj\\Main.verse';
  assert.equal(
    toDebuggerPath('c:/code/proj/helper.VERSE', programPath, listing('Main.verse', 'Helper.verse')),
    'C:\\Code\\Proj\\Helper.verse',
  );
});

test('toDebuggerPath follows the separator of the program path when the program path uses slashes', () => {
  const programPath = 'C:/Code/Proj/Main.verse';
  assert.equal(
    toDebuggerPath('C:\\Code\\Proj\\helper.verse', programPath, listing('Helper.verse')),
    'C:/Code/Proj/Helper.verse',
  );
});

test('toDebuggerPath uses the last separator when the program path mixes them', () => {
  const programPath = 'C:\\Code/Proj\\Main.verse';
  assert.equal(
    toDebuggerPath('c:/code/proj/Helper.verse', programPath, listing('Helper.verse')),
    'C:\\Code/Proj\\Helper.verse',
  );
});

test('toDebuggerPath keeps the name the client sent when the file is not on disk', () => {
  const programPath = 'C:\\Code\\Proj\\Main.verse';
  assert.equal(
    toDebuggerPath('c:/code/proj/New.verse', programPath, listing('Main.verse')),
    'C:\\Code\\Proj\\New.verse',
  );
});

test('toDebuggerPath asks the lister about the folder of the program', () => {
  const requestedFolders: string[] = [];
  const recordingLister = (folderPath: string): readonly string[] => {
    requestedFolders.push(folderPath);
    return [];
  };
  toDebuggerPath('c:/code/proj/a.verse', 'C:\\Code\\Proj\\Main.verse', recordingLister);
  assert.deepEqual(requestedFolders, ['C:/Code/Proj']);
});

test('toDebuggerPath passes a subfolder file and another folder through unchanged', () => {
  const programPath = 'C:\\Code\\Proj\\Main.verse';
  assert.equal(toDebuggerPath('c:/code/proj/sub/a.verse', programPath, listing('a.verse')), 'c:/code/proj/sub/a.verse');
  assert.equal(toDebuggerPath('D:\\Other\\a.verse', programPath, listing('a.verse')), 'D:\\Other\\a.verse');
});

test('toDebuggerPath handles a program in a drive root and Japanese names', () => {
  assert.equal(
    toDebuggerPath('c:/ヘルパー.verse', 'C:\\Main.verse', listing('ヘルパー.verse')),
    'C:\\ヘルパー.verse',
  );
});
