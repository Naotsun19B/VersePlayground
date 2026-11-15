// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toEngineLocation } from '../src/shared/engine-locator.ts';
import { canLookUp } from '../src/server/lookup-gate.ts';

test('a folder whose engine is ready may be looked up', () => {
  assert.equal(canLookUp({ status: 'ready', location: toEngineLocation('C:/Engine') }), true);
});

test('a folder that is waiting for the allowance or the ping answers nothing', () => {
  assert.equal(canLookUp({ status: 'preparing' }), false);
});

test('a folder whose engine is not allowed or unusable answers nothing', () => {
  assert.equal(canLookUp({ status: 'unusable' }), false);
});

test('a folder whose last ping failed temporarily answers nothing until it is prepared again', () => {
  assert.equal(canLookUp({ status: 'retryLater' }), false);
});

test('a folder the server does not know answers nothing', () => {
  assert.equal(canLookUp(undefined), false);
});
