// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toClientVariables } from '../src/debug-values.ts';

test('removes the module path from field names', () => {
  const clientBody = toClientVariables({
    variables: [{ name: '(/user@localhost/point:)X', value: '4', variablesReference: 0 }],
  });
  assert.deepEqual(clientBody.variables, [{ name: 'X', value: '4', variablesReference: 0 }]);
});

test('removes every module path from a struct value', () => {
  const clientBody = toClientVariables({
    variables: [{ name: 'Where', value: '(/user@localhost:)point{X := 4, Y := 5}', variablesReference: 1073741824 }],
  });
  assert.deepEqual(clientBody.variables, [
    { name: 'Where', value: 'point{X := 4, Y := 5}', variablesReference: 1073741824 },
  ]);
});

test('leaves the text of strings and characters alone', () => {
  const clientBody = toClientVariables({
    variables: [
      { name: 'Line', value: '"(/user@localhost:)kept"', variablesReference: 0 },
      { name: 'Letter', value: '\'a\'', variablesReference: 0 },
    ],
  });
  const clientValues = clientBody.variables.map((clientVariable) => clientVariable.value);
  assert.deepEqual(clientValues, ['"(/user@localhost:)kept"', '\'a\'']);
});

test('returns no variables when the body has none', () => {
  assert.deepEqual(toClientVariables({}), { variables: [] });
});
