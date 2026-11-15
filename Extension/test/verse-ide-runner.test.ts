// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EngineRegistry, type EngineFinder, type PingRunner } from '../src/server/engine-registry.ts';
import { buildCheckRequest, buildLookupRequest, buildPingRequest } from '../src/server/ide-protocol.ts';
import { ProcessSlots, VerseIdeRunner, type RunnerOptions, type RunOutcome } from '../src/server/verse-ide-runner.ts';
import { toEngineLocation, type EngineResolution } from '../src/shared/engine-locator.ts';

/** The stand-in for verse.exe, which is run by the Node executable. */
const FAKE_SCRIPT = fileURLToPath(new URL('./fixtures/fake-verse-ide.mjs', import.meta.url));

/** The stand-in that records its own start and end times in a file, to be copied once per fake engine. */
const RECORDING_SCRIPT = fileURLToPath(new URL('./fixtures/recording-verse-ide.mjs', import.meta.url));

/** Creates a runner that starts the fake exe in the given mode. */
function createRunner(
  mode: string,
  extraOptions: Readonly<Partial<RunnerOptions>> = {},
  extraArguments: readonly string[] = [],
): VerseIdeRunner {
  return new VerseIdeRunner({
    command: process.execPath,
    args: [FAKE_SCRIPT, '--ide-request', mode, ...extraArguments],
    ...extraOptions,
  });
}

/** Builds a check request with one small override. */
function createCheck(text = 'Print("a")'): ReturnType<typeof buildCheckRequest> {
  return buildCheckRequest('C:/Proj', [{ path: 'C:/Proj/Main.verse', text }]);
}

/** Builds a hover request. */
function createHover(): ReturnType<typeof buildLookupRequest> {
  return buildLookupRequest('hover', 'C:/Proj', 'C:/Proj/Main.verse', { line: 0, byte: 1 }, []);
}

/** Polls until the condition holds, and fails the test when it does not within the time. */
async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Returns the text of the hover of an ok outcome, split at "|" into what the fake exe reported. */
function readEcho(outcome: RunOutcome): string[] {
  assert.ok(outcome.status === 'ok', `Expected an ok outcome but got ${outcome.status}.`);
  assert.ok(outcome.response.hover !== null);
  return outcome.response.hover.text.split('|');
}

test('the answer line is returned and the request reaches stdin as UTF-8 without a BOM', async () => {
  const runner = createRunner('echo');
  const request = createCheck('Print("日本語")');
  const [kind, length, bomText] = readEcho(await runner.run(request));
  assert.equal(kind, 'check');
  assert.equal(Number(length), Buffer.byteLength(JSON.stringify(request), 'utf8'));
  assert.equal(bomText, 'false');
});

test('output around the answer is ignored and a prefix in the middle of a line does not count', async () => {
  const outcome = await createRunner('noise').run(createCheck());
  assert.equal(outcome.status, 'ok');
});

test('a multibyte character split between two chunks is decoded whole', async () => {
  const outcome = await createRunner('split').run(createHover());
  assert.equal(outcome.status, 'ok');
  assert.ok(outcome.status === 'ok');
  assert.equal(outcome.response.hover?.text, '日本語');
});

test('an answer without a line terminator is accepted when the process ends', async () => {
  const outcome = await createRunner('no-newline').run(createCheck());
  assert.equal(outcome.status, 'ok');
});

test('ok: false is reported as a rejection', async () => {
  const outcome = await createRunner('reject').run(createCheck());
  assert.deepEqual(outcome, { status: 'rejected', error: 'bad request' });
});

test('another protocol version is reported as a mismatch', async () => {
  const outcome = await createRunner('protocol2').run(buildPingRequest());
  assert.deepEqual(outcome, { status: 'protocolMismatch', protocol: 2 });
});

test('a malformed answer is reported as invalid', async () => {
  const outcome = await createRunner('garbage').run(createCheck());
  assert.equal(outcome.status, 'invalid');
});

test('the answer is returned without waiting for the process, which is killed after the delay', async () => {
  const runner = createRunner('linger', { killDelayMs: 300 });
  const startedAt = Date.now();
  const outcome = await runner.run(createCheck());
  assert.equal(outcome.status, 'ok');
  assert.ok(Date.now() - startedAt < 250, 'The answer must not wait for the kill delay.');

  // The slot is still held while the process lives, and is returned once it has closed.
  assert.equal(runner.runningCount, 1);
  await waitFor(() => runner.runningCount === 0, 'the lingering process to be killed');
});

test('a process that does not answer is killed at the timeout', async () => {
  const runner = createRunner('hang', { timeoutMs: 300 });
  const outcome = await runner.run(createCheck());
  assert.equal(outcome.status, 'timeout');
  await waitFor(() => runner.runningCount === 0, 'the slot to be returned after the kill');
});

test('aborting a running request kills the process and returns the slot after it has closed', async () => {
  const runner = createRunner('hang');
  const controller = new AbortController();
  const pending = runner.run(createHover(), controller.signal);
  await waitFor(() => runner.runningCount === 1, 'the process to start');

  controller.abort();
  assert.deepEqual(await pending, { status: 'cancelled' });
  await waitFor(() => runner.runningCount === 0, 'the slot to be returned');
});

test('aborting a waiting request removes it from the queue without starting a process', async () => {
  const runner = createRunner('hang', { totalSlots: 1, lookupReservedSlots: 0 });
  const first = runner.run(createCheck());
  await waitFor(() => runner.runningCount === 1, 'the first process to start');

  const controller = new AbortController();
  const waiting = runner.run(createCheck(), controller.signal);
  assert.equal(runner.queuedCount, 1);

  controller.abort();
  assert.deepEqual(await waiting, { status: 'cancelled' });
  assert.equal(runner.queuedCount, 0);
  assert.equal(runner.runningCount, 1);

  runner.cancelAll();
  assert.deepEqual(await first, { status: 'cancelled' });
});

test('an already aborted signal never starts a process', async () => {
  const runner = createRunner('echo');
  const outcome = await runner.run(createCheck(), AbortSignal.abort());
  assert.deepEqual(outcome, { status: 'cancelled' });
  assert.equal(runner.runningCount, 0);
});

test('a waiting request starts only after the slot of the earlier one has closed', async () => {
  const runner = createRunner('linger', { totalSlots: 1, lookupReservedSlots: 0, killDelayMs: 300 });
  const first = await runner.run(createCheck());
  assert.equal(first.status, 'ok');

  // The first process has answered but still lives, so the next request must wait for its close.
  const secondStartedAt = Date.now();
  const second = await runner.run(createCheck());
  assert.equal(second.status, 'ok');
  assert.ok(Date.now() - secondStartedAt >= 200, 'The second request must wait for the first close.');
});

/** Returns the largest number of fake processes that ran at the same time, from the times they reported. */
function countMaxOverlap(outcomes: readonly RunOutcome[]): number {
  const events: { time: number; delta: number }[] = [];
  for (const outcome of outcomes) {
    const [, , , startedAt, endedAt] = readEcho(outcome);
    events.push({ time: Number(startedAt), delta: 1 }, { time: Number(endedAt), delta: -1 });
  }

  // At the same time, an end sorts before a start: a slot that closed can be reused.
  events.sort((first, second) => (first.time - second.time) || (first.delta - second.delta));
  let current = 0;
  let maximum = 0;
  for (const event of events) {
    current += event.delta;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

test('checks use at most three of the four slots', async () => {
  const runner = createRunner('slow', {}, ['400']);
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => runner.run(createCheck())));
  assert.equal(countMaxOverlap(outcomes), 3);
});

test('runners of two engines that share the slots never run more than four processes together', async () => {
  const slots = new ProcessSlots();
  const firstEngine = createRunner('slow', { slots }, ['400']);
  const secondEngine = createRunner('slow', { slots }, ['400']);
  const outcomes = await Promise.all([
    ...Array.from({ length: 4 }, () => firstEngine.run(createCheck())),
    ...Array.from({ length: 4 }, () => secondEngine.run(createCheck())),
    ...Array.from({ length: 2 }, () => firstEngine.run(createHover())),
    ...Array.from({ length: 2 }, () => secondEngine.run(createHover())),
  ]);
  assert.ok(outcomes.every((outcome) => outcome.status === 'ok'));
  assert.ok(countMaxOverlap(outcomes) <= 4, 'The two runners must not exceed the shared total.');
  assert.ok(countMaxOverlap(outcomes.slice(0, 8)) <= 3, 'The checks of both runners must use at most three slots.');
});

/** One line of the file that the recording fake exe writes. */
interface RecordedEvent {
  /** Whether the process started or ended. */
  event: string;

  /** The file name of the fake exe, which tells the engine. */
  script: string;

  /** The kind of the request the process handled. */
  kind: string;

  /** The time the process recorded, in milliseconds. */
  time: number;
}

/** The temporary folders of the tests below, removed once all tests have run. */
const temporaryFolders: string[] = [];

after(() => {
  for (const folder of temporaryFolders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

/** Returns the largest number of processes that were between their start and end records at the same time. */
function countRecordedOverlap(events: readonly RecordedEvent[]): number {
  // At the same time, an end sorts before a start: a slot that closed can be reused.
  const sortedEvents = [...events].sort(
    (first, second) => (first.time - second.time) || (Number(first.event === 'start') - Number(second.event === 'start')),
  );
  let current = 0;
  let maximum = 0;
  for (const event of sortedEvents) {
    current += (event.event === 'start' ? 1 : -1);
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

test('two engines with different commands never have more than four processes alive, seen by the fake exes', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'verse-ide-runner-'));
  temporaryFolders.push(folder);
  const recordFile = path.join(folder, 'record.txt');

  // Two fake engines whose executables are different scripts, as the verse.exe of two engines are different files.
  const engineDirs = ['C:/Engines/One', 'C:/Engines/Two'];
  const slots = new ProcessSlots();
  const runnersByVersePath = new Map<string, VerseIdeRunner>();
  for (const [index, engineDir] of engineDirs.entries()) {
    const scriptPath = path.join(folder, `engine-${index + 1}.mjs`);
    copyFileSync(RECORDING_SCRIPT, scriptPath);
    runnersByVersePath.set(
      toEngineLocation(engineDir).versePath,
      new VerseIdeRunner({ command: process.execPath, args: [scriptPath, '--ide-request', recordFile, '300'], slots }),
    );
  }
  const runners = [...runnersByVersePath.values()];

  // The registry pings through the runner of the engine, so its pings use the shared slots like the checks do.
  const findEngine: EngineFinder = (_configuredEngineDir, startFolders) => {
    const engineDir = (startFolders[0]?.startsWith('C:/Work') === true ? engineDirs[0] : engineDirs[1]);
    const resolution: EngineResolution = { location: toEngineLocation(engineDir!), source: { kind: 'setting' } };
    return resolution;
  };
  const pingRunner: PingRunner = {
    ping: async (versePath) => {
      const outcome = await runnersByVersePath.get(versePath)!.run(buildPingRequest());
      return (
        outcome.status === 'ok' ?
        { kind: 'answered', responseJson: '{"protocol":1,"ok":true}' } :
        { kind: 'failed', message: outcome.status }
      );
    },
  };
  const registry = new EngineRegistry({
    configuredEngineDir: '',
    workspaceFolders: ['C:/Work', 'C:/Other'],
    findEngine,
    pingRunner,
    client: {
      approveEngine: () => Promise.resolve(true),
      notifyUnavailable: () => undefined,
      log: () => undefined,
    },
    now: () => Date.now(),
  });

  const locations = await Promise.all([
    registry.prepare('C:/Work/A'),
    registry.prepare('C:/Work/B'),
    registry.prepare('C:/Other/A'),
    registry.prepare('C:/Other/B'),
  ]);
  assert.ok(locations.every((location) => location !== undefined), 'Every folder must be usable.');

  const outcomes = await Promise.all(runners.flatMap((runner) => [
    ...Array.from({ length: 4 }, () => runner.run(createCheck())),
    ...Array.from({ length: 2 }, () => runner.run(createHover())),
  ]));
  assert.ok(outcomes.every((outcome) => outcome.status === 'ok'));

  const events: RecordedEvent[] = readFileSync(recordFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [event, script, kind, time] = line.split('|');
      return { event: event!, script: script!, kind: kind!, time: Number(time) };
    });

  // Two pings (one per engine, shared by the folders of an engine), eight checks and four lookups.
  assert.equal(events.filter((event) => event.event === 'start').length, 14);
  assert.equal(events.filter((event) => event.event === 'end').length, 14);
  assert.deepEqual([...new Set(events.map((event) => event.script))].sort(), ['engine-1.mjs', 'engine-2.mjs']);

  const maximum = countRecordedOverlap(events);
  assert.ok(maximum >= 2, 'The engines must have run side by side for the limit to be tested.');
  assert.ok(maximum <= 4, `The fake exes saw ${maximum} processes at once, over the limit of four.`);
  assert.ok(
    countRecordedOverlap(events.filter((event) => event.kind === 'check')) <= 3,
    'The checks must leave one slot for hover and definition.',
  );
});

test('runners that do not share slots each keep their own limit', async () => {
  const firstEngine = createRunner('slow', {}, ['400']);
  const secondEngine = createRunner('slow', {}, ['400']);
  const outcomes = await Promise.all([
    ...Array.from({ length: 3 }, () => firstEngine.run(createCheck())),
    ...Array.from({ length: 3 }, () => secondEngine.run(createCheck())),
  ]);
  assert.equal(countMaxOverlap(outcomes), 6);
});

test('cancelAll of one runner cancels the requests of the runners that share its slots', async () => {
  const slots = new ProcessSlots();
  const firstEngine = createRunner('hang', { slots, timeoutMs: 60_000 });
  const secondEngine = createRunner('hang', { slots, timeoutMs: 60_000 });
  const first = firstEngine.run(createCheck());
  const second = secondEngine.run(createCheck());
  await waitFor(() => slots.runningCount === 2, 'both processes to start');

  firstEngine.cancelAll();
  assert.deepEqual(await first, { status: 'cancelled' });
  assert.deepEqual(await second, { status: 'cancelled' });
  await waitFor(() => slots.runningCount === 0, 'every slot to be returned');
});

test('the reserved slot lets a hover run while the checks fill their slots', async () => {
  const runner = createRunner('hang', { timeoutMs: 60_000 });
  const checks = Array.from({ length: 4 }, () => runner.run(createCheck()));
  await waitFor(() => runner.runningCount === 3, 'three checks to run');
  assert.equal(runner.queuedCount, 1, 'The fourth check must wait.');

  const hover = runner.run(createHover());
  await waitFor(() => runner.runningCount === 4, 'the hover to take the reserved slot');
  assert.equal(runner.queuedCount, 1);

  runner.cancelAll();
  const outcomes = await Promise.all([...checks, hover]);
  assert.ok(outcomes.every((outcome) => outcome.status === 'cancelled'));
  await waitFor(() => runner.runningCount === 0, 'every slot to be returned');
});

test('a waiting hover is served before a waiting check', async () => {
  const runner = createRunner('slow', { totalSlots: 1, lookupReservedSlots: 0 }, ['100']);
  const running = runner.run(createCheck());
  await waitFor(() => runner.runningCount === 1, 'the first process to start');

  const check = runner.run(createCheck());
  const hover = runner.run(createHover());
  const [, , , , checkEndedAt] = readEcho(await check);
  const [, , , , hoverEndedAt] = readEcho(await hover);
  assert.ok(Number(hoverEndedAt) <= Number(checkEndedAt), 'The hover must have been served first.');
  await running;
});

test('a missing executable is reported as a spawn failure', async () => {
  const runner = new VerseIdeRunner({ command: 'F:/this/verse-ide/does-not-exist.exe', args: ['--ide-request'] });
  const outcome = await runner.run(buildPingRequest());
  assert.equal(outcome.status, 'spawnFailed');
  assert.ok(outcome.status === 'spawnFailed');
  assert.equal(outcome.code, 'ENOENT');
  await waitFor(() => runner.runningCount === 0, 'the slot to be returned');
});

test('a process that exits without reading stdin does not take the server down (EPIPE)', async () => {
  const runner = createRunner('exit-early');

  // A body far larger than the pipe buffer, so that the write is still going on when the process is gone.
  const outcome = await runner.run(createCheck('x'.repeat(8 * 1024 * 1024)));
  assert.equal(outcome.status, 'noResponse');
  assert.ok(outcome.status === 'noResponse');
  assert.equal(outcome.exitCode, 0);
  await waitFor(() => runner.runningCount === 0, 'the slot to be returned');
});

test('a process that only writes to stderr is a failure that carries the stderr', async () => {
  const outcome = await createRunner('stderr-only').run(createCheck());
  assert.equal(outcome.status, 'noResponse');
  assert.ok(outcome.status === 'noResponse');
  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.stderr, /boom: something went wrong/);
});

test('an old verse.exe that does not know the flag ends with exit code 1 and no answer', async () => {
  const runner = new VerseIdeRunner({ command: process.execPath, args: [FAKE_SCRIPT] });
  const outcome = await runner.run(buildPingRequest());
  assert.equal(outcome.status, 'noResponse');
  assert.ok(outcome.status === 'noResponse');
  assert.equal(outcome.exitCode, 1);
});

test('too much stdout kills the process and fails the run', async () => {
  const runner = createRunner('flood', { maxStdoutBytes: 10_000 });
  const outcome = await runner.run(createCheck());
  assert.equal(outcome.status, 'outputTooLarge');
  await waitFor(() => runner.runningCount === 0, 'the slot to be returned');
});

test('stderr is cut at its limit', async () => {
  const runner = createRunner('stderr-only', { maxStderrBytes: 5 });
  const outcome = await runner.run(createCheck());
  assert.ok(outcome.status === 'noResponse');
  assert.equal(outcome.stderr, 'boom:');
});

test('a request over the size limit is refused without starting a process', async () => {
  const runner = createRunner('echo');
  const outcome = await runner.run(createCheck('x'.repeat(33 * 1024 * 1024)));
  assert.equal(outcome.status, 'requestTooLarge');
  assert.equal(runner.runningCount, 0);
});

test('cancelAll cancels waiting and running requests', async () => {
  const runner = createRunner('hang', { totalSlots: 1, lookupReservedSlots: 0 });
  const running = runner.run(createCheck());
  await waitFor(() => runner.runningCount === 1, 'the process to start');
  const waiting = runner.run(createCheck());

  runner.cancelAll();
  assert.deepEqual(await running, { status: 'cancelled' });
  assert.deepEqual(await waiting, { status: 'cancelled' });
  await waitFor(() => runner.runningCount === 0, 'the slot to be returned');
  assert.equal(runner.queuedCount, 0);
});
