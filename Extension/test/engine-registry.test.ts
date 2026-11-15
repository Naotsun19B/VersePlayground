// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EngineRegistry,
  TRANSIENT_FAILURE_SUPPRESSION_MS,
  type EngineFinder,
  type PingProcessResult,
  type PingRunner,
} from '../src/server/engine-registry.ts';
import { toEngineLocation, type EngineResolution } from '../src/shared/engine-locator.ts';
import type { ApproveEngineParams, UnavailableParams } from '../src/shared/protocol-types.ts';

// The engine folder of everything under C:/Work.
const ENGINE_ONE = 'C:/Engines/One';
// The engine folder of everything under C:/Other.
const ENGINE_TWO = 'C:/Engines/Two';
// The answer line of a verse.exe that speaks this protocol.
const OK_ANSWER = '{"protocol":1,"ok":true}';

/** A ping that ends when the test says so. */
interface HeldPing {
  // The verse.exe that was pinged.
  versePath: string;

  // Ends the ping with a result.
  finish(result: PingProcessResult): void;
}

/** Everything a test needs to observe. */
interface Harness {
  // The registry under test.
  registry: EngineRegistry;

  // The folders findEngine was asked about, with their start folders.
  findCalls: (readonly string[])[];

  // The approval requests.
  approvals: ApproveEngineParams[];

  // The unavailable notifications.
  unavailable: UnavailableParams[];

  // The log lines.
  logs: string[];

  // Pings that were started and have not been finished by the test.
  heldPings: HeldPing[];

  // Total pings started.
  pingCount: () => number;

  // What the next approval request answers; a function so that a test can hold it.
  setApproval(answer: (params: ApproveEngineParams) => Promise<boolean>): void;

  // Moves the fake clock.
  advanceTime(durationMs: number): void;
}

/** Makes a registry whose findEngine maps every folder under C:/Work to ENGINE_ONE, and others to nothing. */
function createHarness(engineDirByFolderPrefix?: Readonly<Record<string, string>>): Harness {
  const findCalls: (readonly string[])[] = [];
  const approvals: ApproveEngineParams[] = [];
  const unavailable: UnavailableParams[] = [];
  const logs: string[] = [];
  const heldPings: HeldPing[] = [];
  let totalPings = 0;
  let currentTime = 1000;
  let answerApproval: (params: ApproveEngineParams) => Promise<boolean> = () => Promise.resolve(true);
  const prefixes = engineDirByFolderPrefix ?? { 'C:/Work': ENGINE_ONE, 'C:/Other': ENGINE_TWO };

  const findEngine: EngineFinder = (_configuredEngineDir, startFolders) => {
    findCalls.push(startFolders);
    const [firstFolder] = startFolders;
    for (const [prefix, engineDir] of Object.entries(prefixes)) {
      if (firstFolder?.startsWith(prefix)) {
        const resolution: EngineResolution = {
          location: toEngineLocation(engineDir),
          source: { kind: 'setting' },
        };
        return resolution;
      }
    }
    return undefined;
  };

  const pingRunner: PingRunner = {
    ping: (versePath) => {
      totalPings += 1;
      return new Promise((resolve) => {
        heldPings.push({ versePath, finish: resolve });
      });
    },
  };

  const registry = new EngineRegistry({
    configuredEngineDir: '',
    workspaceFolders: ['C:/Work'],
    findEngine,
    pingRunner,
    client: {
      approveEngine: (params) => {
        approvals.push({ ...params });
        return answerApproval(params);
      },
      notifyUnavailable: (params) => {
        unavailable.push({ ...params });
      },
      log: (message) => {
        logs.push(message);
      },
    },
    now: () => currentTime,
  });

  return {
    registry,
    findCalls,
    approvals,
    unavailable,
    logs,
    heldPings,
    pingCount: () => totalPings,
    setApproval: (answer) => {
      answerApproval = answer;
    },
    advanceTime: (durationMs) => {
      currentTime += durationMs;
    },
  };
}

/** Lets pending promise callbacks run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** Prepares a folder, answers its ping and returns what prepare returned. */
async function prepareWithAnswer(harness: Harness, folder: string, result: PingProcessResult): Promise<unknown> {
  const preparation = harness.registry.prepare(folder);
  await flush();
  harness.heldPings.shift()?.finish(result);
  return preparation;
}

test('a folder whose engine answers the ping is usable', async () => {
  const harness = createHarness();
  const location = await prepareWithAnswer(harness, 'C:/Work/One', { kind: 'answered', responseJson: OK_ANSWER });
  assert.deepEqual(location, toEngineLocation(ENGINE_ONE));
  assert.deepEqual(harness.findCalls, [['C:/Work/One', 'C:/Work']]);
  assert.deepEqual(harness.unavailable, []);
});

test('a folder without an engine is not handled and nobody is asked', async () => {
  const harness = createHarness();
  assert.equal(await harness.registry.prepare('D:/Nowhere'), undefined);
  assert.deepEqual(harness.approvals, []);
  assert.equal(harness.pingCount(), 0);
});

test('the engine of a folder is cached, including the absence of one, until it is invalidated', async () => {
  const harness = createHarness();
  await harness.registry.prepare('D:/Nowhere');
  await harness.registry.prepare('D:/Nowhere');
  assert.equal(harness.findCalls.length, 1);

  harness.registry.invalidateFolder('d:\\nowhere');
  await harness.registry.prepare('D:/Nowhere');
  assert.equal(harness.findCalls.length, 2);

  harness.registry.invalidateAllFolders();
  await harness.registry.prepare('D:/Nowhere');
  assert.equal(harness.findCalls.length, 3);
});

test('the allowance is asked for every folder and every time, never cached', async () => {
  const harness = createHarness();
  await prepareWithAnswer(harness, 'C:/Work/One', { kind: 'answered', responseJson: OK_ANSWER });
  await harness.registry.prepare('C:/Work/One');
  await harness.registry.prepare('C:/Work/Two');
  assert.deepEqual(harness.approvals.map((approval) => approval.folder), [
    'C:/Work/One',
    'C:/Work/One',
    'C:/Work/Two',
  ]);
  assert.deepEqual(harness.approvals[0]?.engineDir, ENGINE_ONE);
  assert.deepEqual(harness.approvals[0]?.source, { kind: 'setting' });
});

test('a refused allowance means the folder is not handled and the engine is not pinged', async () => {
  const harness = createHarness();
  harness.setApproval(() => Promise.resolve(false));
  assert.equal(await harness.registry.prepare('C:/Work/One'), undefined);
  assert.equal(harness.pingCount(), 0);
  assert.deepEqual(harness.unavailable, []);
});

test('a refusal for one folder does not stop another folder of the same engine', async () => {
  const harness = createHarness();
  harness.setApproval((params) => Promise.resolve(params.folder !== 'C:/Work/One'));
  assert.equal(await harness.registry.prepare('C:/Work/One'), undefined);

  const location = await prepareWithAnswer(harness, 'C:/Work/Two', { kind: 'answered', responseJson: OK_ANSWER });
  assert.deepEqual(location, toEngineLocation(ENGINE_ONE));
});

test('a request for a folder waits for the allowance that is already being asked', async () => {
  const harness = createHarness();
  let answer: (isAllowed: boolean) => void = () => {};
  harness.setApproval(() => new Promise<boolean>((resolve) => {
    answer = resolve;
  }));

  const first = harness.registry.prepare('C:/Work/One');
  const second = harness.registry.prepare('C:/Work/One');
  await flush();
  assert.equal(harness.approvals.length, 1, 'one confirmation for the folder');
  assert.equal(harness.pingCount(), 0, 'nothing runs before the user answers');

  answer(true);
  await flush();
  harness.heldPings.shift()?.finish({ kind: 'answered', responseJson: OK_ANSWER });
  assert.deepEqual(await first, toEngineLocation(ENGINE_ONE));
  assert.deepEqual(await second, toEngineLocation(ENGINE_ONE));
});

test('folders of the same engine share one ping that is running', async () => {
  const harness = createHarness();
  const first = harness.registry.prepare('C:/Work/One');
  const second = harness.registry.prepare('C:/Work/Two');
  await flush();
  assert.equal(harness.pingCount(), 1);

  harness.heldPings.shift()?.finish({ kind: 'answered', responseJson: OK_ANSWER });
  assert.notEqual(await first, undefined);
  assert.notEqual(await second, undefined);
  assert.equal(harness.pingCount(), 1);
});

test('a folder that arrives after the ping finished uses the remembered result without a new ping', async () => {
  const harness = createHarness();
  await prepareWithAnswer(harness, 'C:/Work/One', { kind: 'answered', responseJson: OK_ANSWER });
  assert.notEqual(await harness.registry.prepare('C:/Work/Two'), undefined);
  assert.equal(harness.pingCount(), 1);
});

test('different engines are pinged separately', async () => {
  const harness = createHarness();
  const first = harness.registry.prepare('C:/Work/One');
  const second = harness.registry.prepare('C:/Other/One');
  await flush();
  assert.deepEqual(harness.heldPings.map((ping) => ping.versePath), [
    toEngineLocation(ENGINE_ONE).versePath,
    toEngineLocation(ENGINE_TWO).versePath,
  ]);

  for (const ping of harness.heldPings.splice(0)) {
    ping.finish({ kind: 'answered', responseJson: OK_ANSWER });
  }
  await first;
  await second;
});

test('a protocol mismatch is reported once and remembered', async () => {
  const harness = createHarness();
  const answer: PingProcessResult = { kind: 'answered', responseJson: '{"protocol":2,"ok":true}' };
  assert.equal(await prepareWithAnswer(harness, 'C:/Work/One', answer), undefined);
  assert.deepEqual(harness.unavailable, [{
    reason: 'protocol',
    versePath: toEngineLocation(ENGINE_ONE).versePath,
    engineDir: ENGINE_ONE,
  }]);

  assert.equal(await harness.registry.prepare('C:/Work/Two'), undefined);
  assert.equal(harness.pingCount(), 1);
  assert.equal(harness.unavailable.length, 1);
});

test('a missing verse.exe is reported as missing and remembered', async () => {
  const harness = createHarness();
  const result: PingProcessResult = { kind: 'spawnFailed', errorCode: 'ENOENT', message: 'spawn ENOENT' };
  assert.equal(await prepareWithAnswer(harness, 'C:/Work/One', result), undefined);
  assert.equal(harness.unavailable[0]?.reason, 'missing');

  harness.advanceTime(TRANSIENT_FAILURE_SUPPRESSION_MS * 10);
  assert.equal(await harness.registry.prepare('C:/Work/One'), undefined);
  assert.equal(harness.pingCount(), 1, 'a remembered failure is not pinged again, however long ago');
});

test('an exe that exits with 1 and no answer is unsupported and remembered', async () => {
  const harness = createHarness();
  assert.equal(await prepareWithAnswer(harness, 'C:/Work/One', { kind: 'noAnswer', exitCode: 1 }), undefined);
  assert.equal(harness.unavailable[0]?.reason, 'unsupported');
  assert.equal(await harness.registry.prepare('C:/Work/One'), undefined);
  assert.equal(harness.pingCount(), 1);
});

test('a failure that may be temporary is only logged and not reported', async () => {
  const failures: PingProcessResult[] = [
    { kind: 'failed', message: 'timeout' },
    { kind: 'noAnswer', exitCode: 3 },
    { kind: 'noAnswer', exitCode: undefined },
    { kind: 'spawnFailed', errorCode: 'EACCES', message: 'denied' },
    { kind: 'answered', responseJson: 'not json' },
  ];
  for (const failure of failures) {
    const freshHarness = createHarness();
    assert.equal(await prepareWithAnswer(freshHarness, 'C:/Work/One', failure), undefined);
    assert.deepEqual(freshHarness.unavailable, []);
    assert.ok(freshHarness.logs.some((line) => line.includes('failed')), `logged: ${JSON.stringify(failure)}`);
  }
});

test('after a temporary failure the engine is not pinged for 30 seconds, then it is pinged again', async () => {
  const harness = createHarness();
  await prepareWithAnswer(harness, 'C:/Work/One', { kind: 'failed', message: 'timeout' });
  assert.equal(harness.pingCount(), 1);

  harness.advanceTime(TRANSIENT_FAILURE_SUPPRESSION_MS - 1);
  assert.equal(await harness.registry.prepare('C:/Work/One'), undefined);
  assert.equal(harness.pingCount(), 1, 'still suppressed');

  harness.advanceTime(1);
  const location = await prepareWithAnswer(harness, 'C:/Work/One', { kind: 'answered', responseJson: OK_ANSWER });
  assert.equal(harness.pingCount(), 2);
  assert.deepEqual(location, toEngineLocation(ENGINE_ONE));
});

test('restart forgets remembered failures and resolutions so that everything is tried again', async () => {
  const harness = createHarness();
  await prepareWithAnswer(harness, 'C:/Work/One', { kind: 'noAnswer', exitCode: 1 });
  harness.registry.restart();

  const location = await prepareWithAnswer(harness, 'C:/Work/One', { kind: 'answered', responseJson: OK_ANSWER });
  assert.deepEqual(location, toEngineLocation(ENGINE_ONE));
  assert.equal(harness.pingCount(), 2);
  assert.equal(harness.findCalls.length, 2);
});

test('restart also forgets a temporary failure that was still being suppressed', async () => {
  const harness = createHarness();
  await prepareWithAnswer(harness, 'C:/Work/One', { kind: 'failed', message: 'timeout' });
  harness.registry.restart();
  await prepareWithAnswer(harness, 'C:/Work/One', { kind: 'answered', responseJson: OK_ANSWER });
  assert.equal(harness.pingCount(), 2);
});

test('invalidating all folders while the allowance is asked makes the next preparation start over', async () => {
  const harness = createHarness();
  const answers: ((isAllowed: boolean) => void)[] = [];
  harness.setApproval(() => new Promise<boolean>((resolve) => {
    answers.push(resolve);
  }));

  const stale = harness.registry.prepareFolder('C:/Work/One');
  await flush();
  harness.registry.invalidateAllFolders();

  const fresh = harness.registry.prepareFolder('C:/Work/One');
  await flush();
  assert.equal(harness.findCalls.length, 2, 'the engine is searched again');
  assert.equal(harness.approvals.length, 2, 'the new preparation asks on its own');

  answers[1]?.(true);
  await flush();
  harness.heldPings.shift()?.finish({ kind: 'answered', responseJson: OK_ANSWER });
  assert.deepEqual(await fresh, { status: 'ready', location: toEngineLocation(ENGINE_ONE) });

  // The old answer arrives late. It starts over under the new state, so it needs no new ping and changes no cache.
  harness.setApproval(() => Promise.resolve(true));
  answers[0]?.(true);
  assert.deepEqual(await stale, { status: 'ready', location: toEngineLocation(ENGINE_ONE) });
  assert.equal(harness.pingCount(), 1);
  assert.deepEqual(harness.registry.getKnownEngine('C:/Work/One'), toEngineLocation(ENGINE_ONE));
});

test('restart while the allowance is asked makes the old preparation start over without pinging', async () => {
  const harness = createHarness({ 'C:/Work': ENGINE_ONE });
  const answers: ((isAllowed: boolean) => void)[] = [];
  harness.setApproval(() => new Promise<boolean>((resolve) => {
    answers.push(resolve);
  }));

  const stale = harness.registry.prepareFolder('C:/Work/One');
  await flush();
  harness.registry.restart();

  answers[0]?.(true);
  await flush();
  assert.equal(harness.pingCount(), 0, 'the old preparation does not ping with the old state');
  assert.equal(harness.approvals.length, 2, 'it asks again under the new state');

  answers[1]?.(true);
  await flush();
  harness.heldPings.shift()?.finish({ kind: 'answered', responseJson: OK_ANSWER });
  assert.deepEqual(await stale, { status: 'ready', location: toEngineLocation(ENGINE_ONE) });
  assert.equal(harness.pingCount(), 1);
});

test('the known engine of a folder is gone once its cache is dropped', async () => {
  const harness = createHarness();
  await prepareWithAnswer(harness, 'C:/Work/One', { kind: 'answered', responseJson: OK_ANSWER });
  assert.deepEqual(harness.registry.getKnownEngine('C:/Work/One'), toEngineLocation(ENGINE_ONE));

  harness.registry.invalidateFolder('C:/Work/One');
  assert.equal(harness.registry.getKnownEngine('C:/Work/One'), undefined);
});

test('prepareFolder tells a usable engine, a lasting failure and a temporary one apart', async () => {
  const harness = createHarness();
  const readyResult = harness.registry.prepareFolder('C:/Work/One');
  await flush();
  harness.heldPings.shift()?.finish({ kind: 'answered', responseJson: OK_ANSWER });
  assert.deepEqual(await readyResult, { status: 'ready', location: toEngineLocation(ENGINE_ONE) });

  assert.deepEqual(await harness.registry.prepareFolder('D:/Nowhere'), { status: 'unusable' });

  const unsupportedResult = harness.registry.prepareFolder('C:/Other/One');
  await flush();
  harness.heldPings.shift()?.finish({ kind: 'noAnswer', exitCode: 1 });
  assert.deepEqual(await unsupportedResult, { status: 'unusable' });
});

test('prepareFolder reports a temporary failure as retryLater, also while it is suppressed', async () => {
  const harness = createHarness();
  const firstResult = harness.registry.prepareFolder('C:/Work/One');
  await flush();
  harness.heldPings.shift()?.finish({ kind: 'failed', message: 'timeout' });
  assert.deepEqual(await firstResult, { status: 'retryLater' });

  assert.deepEqual(await harness.registry.prepareFolder('C:/Work/One'), { status: 'retryLater' });
  assert.equal(harness.pingCount(), 1);
});

test('prepareFolder reports a refused allowance as unusable', async () => {
  const harness = createHarness();
  harness.setApproval(() => Promise.resolve(false));
  assert.deepEqual(await harness.registry.prepareFolder('C:/Work/One'), { status: 'unusable' });
});
