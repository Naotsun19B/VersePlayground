// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCheckRequest,
  buildLookupRequest,
  buildPingRequest,
  encodeRequest,
  extractResponseLine,
  MAX_REQUEST_BYTES,
  parseOutput,
  parseResponse,
  RESPONSE_PREFIX,
} from '../src/server/ide-protocol.ts';

/** A range used by the answers below. */
const RANGE = { start: { line: 4, byte: 30 }, end: { line: 4, byte: 39 } };

/** Builds the JSON of a successful answer with the given extra members. */
function okJson(extra: Record<string, unknown>): string {
  return JSON.stringify({ protocol: 1, ok: true, ...extra });
}

test('a ping request carries only the protocol and the kind', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(buildPingRequest())), { protocol: 1, kind: 'ping' });
});

test('a check request uses slashes for the folder and for every override path', () => {
  const request = buildCheckRequest(
    'C:\\Users\\x\\Proj\\',
    [
      { path: 'C:\\Users\\x\\Proj\\Main.verse', text: 'Print("あ")' },
    ],
  );
  assert.deepEqual(request, {
    protocol: 1,
    kind: 'check',
    folder: 'C:/Users/x/Proj',
    overrides: [{ path: 'C:/Users/x/Proj/Main.verse', text: 'Print("あ")' }],
  });
});

test('a hover or definition request names the target and the position', () => {
  const request = buildLookupRequest(
    'definition',
    'C:\\Proj',
    'C:\\Proj\\Main.verse',
    { line: 2, byte: 13 },
    [],
  );
  assert.deepEqual(request, {
    protocol: 1,
    kind: 'definition',
    folder: 'C:/Proj',
    target: 'C:/Proj/Main.verse',
    position: { line: 2, byte: 13 },
    overrides: [],
  });
  assert.equal(buildLookupRequest('hover', 'C:/Proj', 'C:/Proj/A.verse', { line: 0, byte: 0 }, []).kind, 'hover');
});

test('building a request does not change the overrides it was given', () => {
  const overrides = [{ path: 'C:\\Proj\\Main.verse', text: 'x' }];
  buildCheckRequest('C:\\Proj', overrides);
  assert.equal(overrides[0].path, 'C:\\Proj\\Main.verse');
});

test('an encoded request is UTF-8 without a BOM and keeps multibyte text', () => {
  const encoded = encodeRequest(buildCheckRequest('C:/Proj', [{ path: 'C:/Proj/A.verse', text: '日本語😀' }]));
  assert.equal(encoded.isOk, true);
  if (encoded.isOk) {
    assert.notEqual(encoded.body[0], 0xef);
    const decoded = JSON.parse(encoded.body.toString('utf8'));
    assert.equal(decoded.overrides[0].text, '日本語😀');
  }
});

test('a request over the size limit is refused', () => {
  const hugeText = 'a'.repeat(MAX_REQUEST_BYTES);
  const encoded = encodeRequest(buildCheckRequest('C:/Proj', [{ path: 'C:/Proj/A.verse', text: hugeText }]));
  assert.equal(encoded.isOk, false);
});

test('the answer line is found among other output', () => {
  const output = `first line\n${RESPONSE_PREFIX}{"protocol":1}\nlast line\n`;
  assert.equal(extractResponseLine(output), '{"protocol":1}');
});

test('the answer line is found when the output uses CRLF', () => {
  assert.equal(extractResponseLine(`noise\r\n${RESPONSE_PREFIX}{"a":1}\r\n`), '{"a":1}');
});

test('a prefix in the middle of a line is not an answer', () => {
  assert.equal(extractResponseLine(`Print says ${RESPONSE_PREFIX}{"protocol":1}\n`), undefined);
});

test('a line that starts with the prefix is found even when the same text also occurs mid-line before it', () => {
  const output = `x ${RESPONSE_PREFIX}{"wrong":1}\n${RESPONSE_PREFIX}{"right":1}\n`;
  assert.equal(extractResponseLine(output), '{"right":1}');
});

test('with several answer lines the first one wins', () => {
  assert.equal(extractResponseLine(`${RESPONSE_PREFIX}{"n":1}\n${RESPONSE_PREFIX}{"n":2}\n`), '{"n":1}');
});

test('empty output, output without a prefix and a prefix without a trailing space have no answer', () => {
  assert.equal(extractResponseLine(''), undefined);
  assert.equal(extractResponseLine('just text\nmore text\n'), undefined);
  assert.equal(extractResponseLine('@verse-ide{"protocol":1}\n'), undefined);
});

test('an empty answer after the prefix is returned as an empty string', () => {
  assert.equal(extractResponseLine(RESPONSE_PREFIX), '');
});

test('a ping answer is ok with no diagnostics', () => {
  const result = parseResponse(okJson({}));
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') {
    assert.deepEqual(result.response.diagnostics, []);
    assert.equal(result.response.hover, null);
    assert.equal(result.response.definition, null);
  }
});

test('diagnostics keep their text, severity, byte range and empty path', () => {
  const answerJson = okJson({
    diagnostics: [
      {
        path: 'C:/Proj/Main.verse',
        code: 3506,
        severity: 'error',
        message: 'Unknown identifier `Undefined`.\nUsed inside function /user@localhost/Main.',
        range: RANGE,
      },
      { path: '', code: 1, severity: 'info', message: 'project wide', range: RANGE },
    ],
  });
  const result = parseResponse(answerJson);
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') {
    assert.equal(result.response.diagnostics.length, 2);
    assert.equal(result.response.diagnostics[0].message.split('\n').length, 2);
    assert.deepEqual(result.response.diagnostics[0].range, RANGE);
    assert.equal(result.response.diagnostics[1].path, '');
  }
});

test('hover and definition results are read, and null means no result', () => {
  const answerJson = okJson({
    hover: { text: '(/user@localhost:)Helper(X:int):int', range: RANGE },
    definition: { path: 'C:/Proj/Helper.verse', range: RANGE },
  });
  const found = parseResponse(answerJson);
  assert.equal(found.status, 'ok');
  if (found.status === 'ok') {
    assert.equal(found.response.hover?.text, '(/user@localhost:)Helper(X:int):int');
    assert.equal(found.response.definition?.path, 'C:/Proj/Helper.verse');
  }

  const none = parseResponse(okJson({ diagnostics: [], hover: null, definition: null }));
  assert.equal(none.status, 'ok');
  if (none.status === 'ok') {
    assert.equal(none.response.hover, null);
    assert.equal(none.response.definition, null);
  }
});

test('ok false is a rejection with the reason', () => {
  const result = parseResponse(JSON.stringify({ protocol: 1, ok: false, error: 'too many files' }));
  assert.deepEqual(result, { status: 'rejected', error: 'too many files' });
});

test('ok false without a reason is still a rejection', () => {
  const result = parseResponse(JSON.stringify({ protocol: 1, ok: false }));
  assert.equal(result.status, 'rejected');
});

test('another protocol version is reported as a mismatch', () => {
  assert.deepEqual(
    parseResponse(JSON.stringify({ protocol: 2, ok: true })),
    { status: 'protocolMismatch', protocol: 2 },
  );
  assert.equal(parseResponse(JSON.stringify({ ok: true })).status, 'protocolMismatch');
});

test('broken JSON and non-objects are invalid', () => {
  assert.equal(parseResponse('{"protocol":1,').status, 'invalid');
  assert.equal(parseResponse('').status, 'invalid');
  assert.equal(parseResponse('null').status, 'invalid');
  assert.equal(parseResponse('[1]').status, 'invalid');
  assert.equal(parseResponse('"text"').status, 'invalid');
});

test('an answer without the ok flag is invalid', () => {
  assert.equal(parseResponse(JSON.stringify({ protocol: 1 })).status, 'invalid');
  assert.equal(parseResponse(JSON.stringify({ protocol: 1, ok: 'yes' })).status, 'invalid');
});

test('malformed diagnostics, hover and definition make the answer invalid', () => {
  assert.equal(parseResponse(okJson({ diagnostics: {} })).status, 'invalid');
  assert.equal(parseResponse(okJson({ diagnostics: [null] })).status, 'invalid');
  const unknownSeverity = { path: 'a', code: 1, severity: 'fatal', message: '', range: RANGE };
  const missingRange = { path: 'a', code: 1, severity: 'error', message: '' };
  const numericPath = { path: 1, code: 1, severity: 'error', message: '', range: RANGE };
  const negativeLineRange = { start: { line: -1, byte: 0 }, end: RANGE.end };
  assert.equal(parseResponse(okJson({ diagnostics: [unknownSeverity] })).status, 'invalid');
  assert.equal(parseResponse(okJson({ diagnostics: [missingRange] })).status, 'invalid');
  assert.equal(parseResponse(okJson({ diagnostics: [numericPath] })).status, 'invalid');
  assert.equal(parseResponse(okJson({ hover: { text: 'x' } })).status, 'invalid');
  assert.equal(parseResponse(okJson({ hover: 'x' })).status, 'invalid');
  assert.equal(parseResponse(okJson({ definition: { path: 'a', range: negativeLineRange } })).status, 'invalid');
});

test('parseOutput finds the answer line in the whole output and validates it', () => {
  const output = `Hello from the script\n${RESPONSE_PREFIX}${okJson({})}\n`;
  assert.equal(parseOutput(output).status, 'ok');
});

test('parseOutput reports output without an answer, and an answer with broken JSON', () => {
  assert.equal(parseOutput('Hello\n').status, 'invalid');
  assert.equal(parseOutput('').status, 'invalid');
  assert.equal(parseOutput(`${RESPONSE_PREFIX}{oops\n`).status, 'invalid');
});
