// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decideLanguageServer } from '../src/language-server.ts';
import type { LanguageServerDecisionInput } from '../src/language-server.ts';

/** Input that starts the builtin server; each test overrides what it examines. */
function makeInput(overrides: Readonly<Partial<LanguageServerDecisionInput>>): LanguageServerDecisionInput {
  return {
    isEnabled: true,
    isTrusted: true,
    isUefnExtensionEnabled: false,
    kind: 'builtin',
    isEngineFound: true,
    ...overrides,
  };
}

test('a disabled server is not started, whatever else is true', () => {
  for (const kind of ['builtin', 'uefn'] as const) {
    assert.deepEqual(
      decideLanguageServer(makeInput({ isEnabled: false, kind })),
      { action: 'skip', reason: 'disabled' },
    );
  }
  assert.deepEqual(
    decideLanguageServer(makeInput({ isEnabled: false, isTrusted: false, isUefnExtensionEnabled: true })),
    { action: 'skip', reason: 'disabled' },
  );
});

test('an untrusted workspace does not start a server', () => {
  for (const kind of ['builtin', 'uefn'] as const) {
    assert.deepEqual(
      decideLanguageServer(makeInput({ isTrusted: false, kind })),
      { action: 'skip', reason: 'untrusted' },
    );
  }
});

test('trust is checked before the UEFN extension', () => {
  assert.deepEqual(
    decideLanguageServer(makeInput({ isTrusted: false, isUefnExtensionEnabled: true })),
    { action: 'skip', reason: 'untrusted' },
  );
});

test('an enabled UEFN extension blocks both kinds', () => {
  for (const kind of ['builtin', 'uefn'] as const) {
    for (const isEngineFound of [true, false]) {
      assert.deepEqual(
        decideLanguageServer(makeInput({ isUefnExtensionEnabled: true, kind, isEngineFound })),
        { action: 'skip', reason: 'uefnExtensionEnabled' },
      );
    }
  }
});

test('the builtin kind starts with or without an engine', () => {
  assert.deepEqual(decideLanguageServer(makeInput({ isEngineFound: true })), { action: 'start', kind: 'builtin' });
  assert.deepEqual(decideLanguageServer(makeInput({ isEngineFound: false })), { action: 'start', kind: 'builtin' });
});

test('the uefn kind needs an engine', () => {
  assert.deepEqual(
    decideLanguageServer(makeInput({ kind: 'uefn', isEngineFound: true })),
    { action: 'start', kind: 'uefn' },
  );
  assert.deepEqual(
    decideLanguageServer(makeInput({ kind: 'uefn', isEngineFound: false })),
    { action: 'skip', reason: 'engineNotFound' },
  );
});

test('the builtin kind does not take the languageServer.path setting into account', () => {
  // The input has no field for the path, so a caller cannot make the decision depend on it.
  // @ts-expect-error The decision input must not accept a path.
  const rejectedInput: LanguageServerDecisionInput = { ...makeInput({}), path: 'C:/server.exe' };
  assert.ok(rejectedInput !== undefined);

  // Even when a path travels along with the facts, the outcome is the one without it.
  for (const isEnabled of [true, false]) {
    for (const isTrusted of [true, false]) {
      for (const isUefnExtensionEnabled of [true, false]) {
        for (const isEngineFound of [true, false]) {
          const input = makeInput({ isEnabled, isTrusted, isUefnExtensionEnabled, isEngineFound, kind: 'builtin' });
          const inputWithExtraPath = { ...input, path: 'C:/does/not/exist/server.exe' };
          assert.deepEqual(decideLanguageServer(inputWithExtraPath), decideLanguageServer(input));
        }
      }
    }
  }
});

test('every combination of the inputs gives the expected outcome', () => {
  const booleans = [true, false];
  for (const isEnabled of booleans) {
    for (const isTrusted of booleans) {
      for (const isUefnExtensionEnabled of booleans) {
        for (const isEngineFound of booleans) {
          for (const kind of ['builtin', 'uefn'] as const) {
            const input = { isEnabled, isTrusted, isUefnExtensionEnabled, kind, isEngineFound };
            const decision = decideLanguageServer(input);
            const isExpectedToStart = (
              isEnabled &&
              isTrusted &&
              !isUefnExtensionEnabled &&
              (kind === 'builtin' || isEngineFound)
            );
            assert.equal(decision.action === 'start', isExpectedToStart);
            if (decision.action === 'start') {
              assert.equal(decision.kind, kind);
            }
          }
        }
      }
    }
  }
});
