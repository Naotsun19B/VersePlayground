// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isCoveredByLanguageServer, isUefnReportingProblems } from '../src/shared/problem-coverage.ts';
import type { FileInfo } from '../src/shared/problem-coverage.ts';
import type { CheckResult } from '../src/shared/protocol-types.ts';

/** A document of a folder, and its URI string as the client names it. */
const MAIN_URI = 'file:///c%3A/Code/Proj/Main.verse';
const HELPER_URI = 'file:///c%3A/Code/Proj/Helper.verse';

/** A saved file in the analyzed folder, outside the engine. */
const MAIN_FILE: FileInfo = { scheme: 'file', fsPath: 'C:\\Code\\Proj\\Main.verse', engineDir: 'C:\\Engine' };

/** A successful analysis of the folder that saw both documents. */
const OK_RESULT: CheckResult = {
  folder: 'C:/Code/Proj',
  state: 'ok',
  versions: { [MAIN_URI]: 3, [HELPER_URI]: 5 },
};

test('is true when the latest analysis succeeded for exactly the documents open now', () => {
  assert.equal(isCoveredByLanguageServer(MAIN_FILE, OK_RESULT, { [MAIN_URI]: 3, [HELPER_URI]: 5 }), true);
});

test('is true when no engine is known', () => {
  const fileWithoutEngine: FileInfo = { ...MAIN_FILE, engineDir: undefined };
  assert.equal(isCoveredByLanguageServer(fileWithoutEngine, OK_RESULT, { [MAIN_URI]: 3, [HELPER_URI]: 5 }), true);
});

test('compares the folder without case or separator differences', () => {
  const result: CheckResult = { ...OK_RESULT, folder: 'c:\\code\\PROJ' };
  assert.equal(isCoveredByLanguageServer(MAIN_FILE, result, { [MAIN_URI]: 3, [HELPER_URI]: 5 }), true);
});

test('is false when there is no analysis yet', () => {
  assert.equal(isCoveredByLanguageServer(MAIN_FILE, undefined, { [MAIN_URI]: 3 }), false);
});

test('is false while the analysis is pending', () => {
  const result: CheckResult = { folder: OK_RESULT.folder, state: 'pending' };
  assert.equal(isCoveredByLanguageServer(MAIN_FILE, result, { [MAIN_URI]: 3, [HELPER_URI]: 5 }), false);
});

test('is false after a failed analysis, so the problem matcher comes back', () => {
  const result: CheckResult = { folder: OK_RESULT.folder, state: 'failed' };
  assert.equal(isCoveredByLanguageServer(MAIN_FILE, result, { [MAIN_URI]: 3, [HELPER_URI]: 5 }), false);
});

test('is false when an ok result carries no versions', () => {
  const result: CheckResult = { folder: OK_RESULT.folder, state: 'ok' };
  assert.equal(isCoveredByLanguageServer(MAIN_FILE, result, {}), false);
});

test('is false when a document was edited after the analysis', () => {
  assert.equal(isCoveredByLanguageServer(MAIN_FILE, OK_RESULT, { [MAIN_URI]: 4, [HELPER_URI]: 5 }), false);
});

test('is false when a document that the analysis did not see is open now', () => {
  const result: CheckResult = { ...OK_RESULT, versions: { [MAIN_URI]: 3 } };
  assert.equal(isCoveredByLanguageServer(MAIN_FILE, result, { [MAIN_URI]: 3, [HELPER_URI]: 5 }), false);
});

test('is false when a document that the analysis saw has been closed since', () => {
  assert.equal(isCoveredByLanguageServer(MAIN_FILE, OK_RESULT, { [MAIN_URI]: 3 }), false);
});

test('is false for the result of another folder', () => {
  const result: CheckResult = { ...OK_RESULT, folder: 'C:/Code/Other' };
  assert.equal(isCoveredByLanguageServer(MAIN_FILE, result, { [MAIN_URI]: 3, [HELPER_URI]: 5 }), false);
});

test('is false for a file inside the engine', () => {
  const engineFile: FileInfo = { scheme: 'file', fsPath: 'C:\\Engine\\Plugins\\A.verse', engineDir: 'C:\\Engine' };
  const result: CheckResult = { folder: 'C:/Engine/Plugins', state: 'ok', versions: {} };
  assert.equal(isCoveredByLanguageServer(engineFile, result, {}), false);
});

test('is false for a document that is not a file, such as an unsaved new file', () => {
  const untitledFile: FileInfo = { scheme: 'untitled', fsPath: 'Untitled-1', engineDir: 'C:\\Engine' };
  assert.equal(isCoveredByLanguageServer(untitledFile, OK_RESULT, {}), false);
});

test('only a folder that merely shares the name prefix with the engine is not inside the engine', () => {
  const siblingFile: FileInfo = { scheme: 'file', fsPath: 'C:\\Code\\Proj\\Main.verse', engineDir: 'C:\\Code\\Pro' };
  assert.equal(isCoveredByLanguageServer(siblingFile, OK_RESULT, { [MAIN_URI]: 3, [HELPER_URI]: 5 }), true);
});

test('an empty engine folder contains nothing', () => {
  const emptyEngineFile: FileInfo = { ...MAIN_FILE, engineDir: '' };
  assert.equal(isCoveredByLanguageServer(emptyEngineFile, OK_RESULT, { [MAIN_URI]: 3, [HELPER_URI]: 5 }), true);
});

test('the engine folder is compared without case or separator differences', () => {
  const engineFile: FileInfo = { scheme: 'file', fsPath: 'c:/engine/Plugins/A.verse', engineDir: 'C:\\ENGINE\\' };
  const result: CheckResult = { folder: 'C:/Engine/Plugins', state: 'ok', versions: {} };
  assert.equal(isCoveredByLanguageServer(engineFile, result, {}), false);
});

test('is false after a restart because the client forgot every result', () => {
  // The client drops its remembered results when the server stops, so the lookup yields undefined.
  assert.equal(isCoveredByLanguageServer(MAIN_FILE, undefined, { [MAIN_URI]: 3, [HELPER_URI]: 5 }), false);
});

/** A file of the workspace, and an engine checkout that is not above it. */
const UEFN_FILE_PATH = 'C:\\Code\\Proj\\Main.verse';
const UEFN_ENGINE_DIR = 'C:\\Engine';

test('the UEFN server reports a file of the workspace outside the engine while it runs', () => {
  assert.equal(isUefnReportingProblems(true, true, UEFN_FILE_PATH, UEFN_ENGINE_DIR), true);
});

test('the UEFN server reports nothing while it is stopped', () => {
  assert.equal(isUefnReportingProblems(false, true, UEFN_FILE_PATH, UEFN_ENGINE_DIR), false);
});

test('the UEFN server reports nothing for a file outside the workspace', () => {
  assert.equal(isUefnReportingProblems(true, false, 'D:\\Elsewhere\\Main.verse', UEFN_ENGINE_DIR), false);
});

test('the UEFN server reports nothing for a file in the engine checkout, even inside the workspace', () => {
  const engineDir = 'C:\\Code\\Proj\\UnrealEngine';
  assert.equal(isUefnReportingProblems(true, true, `${engineDir}\\Plugins\\A.verse`, engineDir), false);
});

test('the UEFN engine folder is compared without case or separator differences', () => {
  const filePath = 'c:/code/proj/unrealengine/A.verse';
  assert.equal(isUefnReportingProblems(true, true, filePath, 'C:\\Code\\Proj\\UnrealEngine\\'), false);
});

test('a folder that merely shares the name prefix with the UEFN engine is not inside the engine', () => {
  assert.equal(isUefnReportingProblems(true, true, UEFN_FILE_PATH, 'C:\\Code\\Pro'), true);
});
