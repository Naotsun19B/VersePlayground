// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { IdeDiagnostic } from '../src/server/ide-protocol.ts';
import { planClear, planPublish, type PublishPlanInput } from '../src/server/publish-plan.ts';

/** The folder of the program in these tests. */
const FOLDER = 'C:/Proj';

/** Builds a diagnostic of verse.exe at the given line and byte range. */
function diagnostic(path: string, line = 0, startByte = 0, endByte = 1, message = 'problem'): IdeDiagnostic {
  return {
    path,
    code: 3506,
    severity: 'error',
    message,
    range: { start: { line, byte: startByte }, end: { line, byte: endByte } },
  };
}

/** Builds an input with sensible defaults. Every field can be replaced. */
function createInput(overrides: Readonly<Partial<PublishPlanInput>> = {}): PublishPlanInput {
  return {
    folder: FOLDER,
    diagnostics: [],
    openDocuments: [],
    previous: new Map(),
    getLineText: () => undefined,
    toUri: (filePath) => `file:///${filePath}`,
    findFirstFileOnDisk: () => undefined,
    ...overrides,
  };
}

test('a diagnostic of an open document is published to the URI of that document', () => {
  const plan = planPublish(createInput({
    diagnostics: [diagnostic('C:/Proj/Main.verse')],
    openDocuments: [{ path: 'c:\\proj\\main.verse', uri: 'file:///c%3A/proj/main.verse' }],
  }));
  assert.deepEqual(plan.items.map((item) => item.uri), ['file:///c%3A/proj/main.verse']);
  assert.deepEqual([...plan.published], [['c:/proj/main.verse', 'file:///c%3A/proj/main.verse']]);
});

test('a diagnostic of a closed file is published to the URI that toUri gives', () => {
  const plan = planPublish(createInput({ diagnostics: [diagnostic('C:/Proj/Other.verse')] }));
  assert.deepEqual(plan.items.map((item) => item.uri), ['file:///C:/Proj/Other.verse']);
});

test('the diagnostics of one file are grouped into one notification, keeping their order', () => {
  const plan = planPublish(createInput({
    diagnostics: [
      diagnostic('C:/Proj/A.verse', 0, 0, 1, 'first'),
      diagnostic('C:/Proj/B.verse', 0, 0, 1, 'other file'),
      diagnostic('C:/Proj/A.verse', 1, 0, 1, 'second'),
    ],
  }));
  assert.equal(plan.items.length, 2);
  assert.deepEqual(plan.items[0].diagnostics.map((item) => item.message), ['first', 'second']);
});

test('UTF-8 byte offsets become UTF-16 columns using the text of the line', () => {
  const lineText = 'Print("日本語"); Print(Undefined)';
  const plan = planPublish(createInput({
    // The 3 Japanese characters take 9 bytes, so "Undefined" starts at byte 26 but at column 20.
    diagnostics: [diagnostic('C:/Proj/Main.verse', 0, 26, 35)],
    getLineText: (_filePath, line) => (line === 0 ? lineText : undefined),
  }));
  const range = plan.items[0].diagnostics[0].range;
  assert.deepEqual(range, { start: { line: 0, character: 20 }, end: { line: 0, character: 29 } });
  assert.equal(lineText.slice(20, 29), 'Undefined');
});

test('a file whose text is unavailable uses the byte offsets as columns and is logged once', () => {
  const plan = planPublish(createInput({
    diagnostics: [diagnostic('C:/Proj/Main.verse', 2, 4, 9), diagnostic('C:/Proj/Main.verse', 3, 1, 2)],
  }));
  assert.deepEqual(plan.items[0].diagnostics[0].range, {
    start: { line: 2, character: 4 },
    end: { line: 2, character: 9 },
  });
  assert.equal(plan.logs.filter((log) => log.includes('C:/Proj/Main.verse')).length, 1);
});

test('severity, code and message are carried over', () => {
  const plan = planPublish(createInput({
    diagnostics: [
      { ...diagnostic('C:/Proj/A.verse', 0, 0, 1, 'multi\nline'), severity: 'warning' },
      { ...diagnostic('C:/Proj/A.verse'), severity: 'info' },
    ],
  }));
  const [warning, info] = plan.items[0].diagnostics;
  assert.equal(warning.severity, 2);
  assert.equal(warning.code, 3506);
  assert.equal(warning.message, 'multi\nline');
  assert.equal(info.severity, 3);
});

test('a diagnostic outside the folder is not published and is logged', () => {
  const plan = planPublish(createInput({
    diagnostics: [
      diagnostic('C:/Engine/Verse/Print.verse'),
      diagnostic('C:/Proj/Sub/Deep.verse'),
      diagnostic('C:/Proj/Main.verse'),
    ],
  }));
  assert.deepEqual(plan.items.map((item) => item.uri), ['file:///C:/Proj/Main.verse']);
  assert.equal(plan.logs.filter((log) => log.includes('outside the folder')).length, 2);
});

test('a project-wide diagnostic goes to the first open document of the folder in name order', () => {
  const plan = planPublish(createInput({
    diagnostics: [diagnostic('', 7, 3, 9)],
    openDocuments: [
      { path: 'C:/Proj/Zeta.verse', uri: 'uri-zeta' },
      { path: 'C:/Proj/alpha.verse', uri: 'uri-alpha' },
      { path: 'C:/Elsewhere/Aaa.verse', uri: 'uri-elsewhere' },
    ],
    findFirstFileOnDisk: () => 'C:/Proj/Disk.verse',
  }));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].uri, 'uri-alpha');
  assert.deepEqual(plan.items[0].diagnostics[0].range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  });
});

test('a project-wide diagnostic goes to the first file on disk when no document of the folder is open', () => {
  const plan = planPublish(createInput({
    diagnostics: [diagnostic('')],
    findFirstFileOnDisk: () => 'C:/Proj/Disk.verse',
  }));
  assert.deepEqual(plan.items.map((item) => item.uri), ['file:///C:/Proj/Disk.verse']);
});

test('a project-wide diagnostic is dropped and logged when the folder has no file at all', () => {
  const plan = planPublish(createInput({ diagnostics: [diagnostic('', 0, 0, 1, 'whole project')] }));
  assert.deepEqual(plan.items, []);
  assert.equal(plan.logs.length, 1);
});

test('a file that had diagnostics and has none now is cleared with the URI that was used', () => {
  const plan = planPublish(createInput({
    diagnostics: [diagnostic('C:/Proj/B.verse')],
    previous: new Map([['c:/proj/a.verse', 'uri-a'], ['c:/proj/b.verse', 'file:///C:/Proj/B.verse']]),
  }));
  assert.deepEqual(plan.items.map((item) => [item.uri, item.diagnostics.length]), [
    ['uri-a', 0],
    ['file:///C:/Proj/B.verse', 1],
  ]);
  assert.deepEqual([...plan.published.keys()], ['c:/proj/b.verse']);
});

test('the old URI is cleared first when the same file is now published to a differently spelled URI', () => {
  const plan = planPublish(createInput({
    diagnostics: [diagnostic('C:/Proj/A.verse')],
    openDocuments: [{ path: 'C:/Proj/A.verse', uri: 'uri-open-spelling' }],
    previous: new Map([['c:/proj/a.verse', 'uri-closed-spelling']]),
  }));
  assert.deepEqual(plan.items.map((item) => [item.uri, item.diagnostics.length]), [
    ['uri-closed-spelling', 0],
    ['uri-open-spelling', 1],
  ]);
});

test('a file published to the same URI again is not cleared', () => {
  const plan = planPublish(createInput({
    diagnostics: [diagnostic('C:/Proj/A.verse')],
    previous: new Map([['c:/proj/a.verse', 'file:///C:/Proj/A.verse']]),
  }));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].diagnostics.length, 1);
});

test('an answer without diagnostics clears everything that was published', () => {
  const plan = planPublish(createInput({ previous: new Map([['c:/proj/a.verse', 'uri-a']]) }));
  assert.deepEqual(plan.items, [{ uri: 'uri-a', diagnostics: [] }]);
  assert.equal(plan.published.size, 0);
});

test('a failed check clears every file that was published and remembers nothing', () => {
  const plan = planClear(new Map([['c:/proj/a.verse', 'uri-a'], ['c:/proj/b.verse', 'uri-b']]));
  assert.deepEqual(plan.items, [
    { uri: 'uri-a', diagnostics: [] },
    { uri: 'uri-b', diagnostics: [] },
  ]);
  assert.equal(plan.published.size, 0);
});

test('clearing nothing gives an empty plan', () => {
  assert.deepEqual(planClear(new Map()).items, []);
});
