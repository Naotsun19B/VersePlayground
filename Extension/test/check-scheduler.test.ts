// Copyright (c) 2026 Naotsun

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CheckScheduler,
  DEBOUNCE_MS,
  type CheckJob,
  type CheckOutcome,
  type CheckRunner,
  type ReleaseReason,
  type SchedulerClock,
} from '../src/server/check-scheduler.ts';
import type { CheckResult } from '../src/shared/protocol-types.ts';

/** A clock that only moves when the test says so. */
class FakeClock implements SchedulerClock {
  // Timers that have not fired, by handle.
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

  // Current fake time in milliseconds.
  private now = 0;

  // Source of handles.
  private nextHandle = 1;

  public setTimer(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { dueAt: this.now + delayMs, callback });
    return handle;
  }

  public clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Moves time forward and fires the timers that fall due, in order. */
  public advance(durationMs: number): void {
    const target = this.now + durationMs;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([_handle, timer]) => timer.dueAt <= target)
        .sort((first, second) => first[1].dueAt - second[1].dueAt)[0];
      if (due === undefined) {
        break;
      }

      this.now = Math.max(this.now, due[1].dueAt);
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.now = target;
  }

  /** Number of timers waiting. */
  public get pendingTimerCount(): number {
    return this.timers.size;
  }
}

/** A runner whose analyses end when the test resolves them. */
class FakeRunner implements CheckRunner<string> {
  // Every job that was started, in order.
  public readonly jobs: CheckJob[] = [];

  // Folders that were cancelled.
  public readonly cancelled: string[] = [];

  // Resolvers of the jobs that have not ended, in start order.
  private readonly resolvers: ((outcome: CheckOutcome<string>) => void)[] = [];

  public run(job: Readonly<CheckJob>): Promise<CheckOutcome<string>> {
    this.jobs.push({ ...job });
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  public cancel(folder: string): void {
    this.cancelled.push(folder);
  }

  /** Ends the oldest running job with an answer and lets the scheduler react. */
  public async answer(response: string): Promise<void> {
    this.resolvers.shift()?.({ isOk: true, response });
    await flush();
  }

  /** Ends the oldest running job with a failure and lets the scheduler react. */
  public async fail(error: string): Promise<void> {
    this.resolvers.shift()?.({ isOk: false, error });
    await flush();
  }
}

/** Lets the promise callbacks of the scheduler run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** Everything a test needs to observe. */
interface Harness {
  // The scheduler under test.
  scheduler: CheckScheduler<string>;

  // Its clock.
  clock: FakeClock;

  // Its runner.
  runner: FakeRunner;

  // Calls to onPublish as [folder, generation, response].
  published: [string, number, string | undefined][];

  // Every checkResult notification.
  results: CheckResult[];

  // Folders that were let go, with the reason.
  released: [string, ReleaseReason][];
}

/** Creates a scheduler. Folders under C:/Work are inside the workspace. */
function createHarness(maxFolders?: number): Harness {
  const clock = new FakeClock();
  const runner = new FakeRunner();
  const published: [string, number, string | undefined][] = [];
  const results: CheckResult[] = [];
  const released: [string, ReleaseReason][] = [];
  const scheduler = new CheckScheduler<string>(
    {
      clock,
      runner,
      isInsideWorkspace: (folder) => folder.startsWith('C:/Work'),
      onPublish: (folder, generation, response) => {
        published.push([folder, generation, response]);
      },
      onCheckResult: (result) => {
        results.push(result);
      },
      onFolderReleased: (folder, reason) => {
        released.push([folder, reason]);
      },
      log: () => {},
    },
    maxFolders,
  );
  return { scheduler, clock, runner, published, results, released };
}

// A folder inside the workspace.
const FOLDER = 'C:/Work/One';
// A folder outside the workspace.
const OTHER_FOLDER = 'D:/Elsewhere/Two';
// Document URI of the first file in FOLDER.
const FILE_A = 'file:///c%3A/Work/One/A.verse';
// Document URI of the second file in FOLDER.
const FILE_B = 'file:///c%3A/Work/One/B.verse';

test('opening a document analyzes at once once the engine is ready', () => {
  const { scheduler, runner } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  assert.equal(runner.jobs.length, 0, 'nothing runs while the engine is not known');

  scheduler.setEngineStatus(FOLDER, 'ready');
  assert.equal(runner.jobs.length, 1);
  assert.deepEqual(runner.jobs[0], { folder: FOLDER, generation: 1, versions: { [FILE_A]: 1 } });
});

test('requests that arrive while the engine is waiting are held and run once, with the latest content', () => {
  const { scheduler, clock, runner } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.changeDocument(FOLDER, FILE_A, 2);
  scheduler.changeDocument(FOLDER, FILE_A, 3);
  clock.advance(DEBOUNCE_MS);
  assert.equal(runner.jobs.length, 0);

  scheduler.setEngineStatus(FOLDER, 'ready');
  assert.equal(runner.jobs.length, 1);
  assert.deepEqual(runner.jobs[0]?.versions, { [FILE_A]: 3 });
});

test('an unusable engine drops the held request and reports the folder as failed', () => {
  const { scheduler, runner, results } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'unusable');
  assert.equal(runner.jobs.length, 0);
  assert.deepEqual(results.map((result) => result.state), ['pending', 'failed']);

  scheduler.changeDocument(FOLDER, FILE_A, 2);
  assert.equal(results.length, 2, 'later edits are not reported while nothing can be analyzed');
});

test('edits are debounced and the debounce restarts on every edit', async () => {
  const { scheduler, clock, runner } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');
  assert.equal(runner.jobs.length, 1);

  await runner.answer('first');
  scheduler.changeDocument(FOLDER, FILE_A, 2);
  clock.advance(DEBOUNCE_MS - 1);
  scheduler.changeDocument(FOLDER, FILE_A, 3);
  clock.advance(DEBOUNCE_MS - 1);
  assert.equal(runner.jobs.length, 1, 'the second edit postponed the check');

  clock.advance(1);
  assert.equal(runner.jobs.length, 2);
  assert.deepEqual(runner.jobs[1]?.versions, { [FILE_A]: 3 });
});

test('a change with the version that open already reported is ignored', () => {
  const { scheduler, clock, runner, results } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');
  const resultCount = results.length;

  scheduler.changeDocument(FOLDER, FILE_A, 1);
  assert.equal(clock.pendingTimerCount, 0);
  assert.equal(results.length, resultCount);
  assert.equal(runner.jobs.length, 1);
});

test('a new edit during a check is held without killing it, then analyzed once with the latest content', async () => {
  const { scheduler, clock, runner, published } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');

  scheduler.changeDocument(FOLDER, FILE_A, 2);
  clock.advance(DEBOUNCE_MS);
  scheduler.changeDocument(FOLDER, FILE_A, 3);
  clock.advance(DEBOUNCE_MS);
  assert.equal(runner.jobs.length, 1, 'only one check runs per folder');
  assert.deepEqual(runner.cancelled, []);

  await runner.answer('first');
  assert.deepEqual(published, [[FOLDER, 1, 'first']], 'the running check is published although another is owed');
  assert.equal(runner.jobs.length, 2);
  assert.deepEqual(runner.jobs[1]?.versions, { [FILE_A]: 3 });

  await runner.answer('second');
  assert.deepEqual(published[1], [FOLDER, 2, 'second']);
  assert.equal(runner.jobs.length, 2);
});

test('typing that continues still lets each finished check be published', async () => {
  const { scheduler, clock, runner, published } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');

  for (let version = 2; version <= 4; version += 1) {
    scheduler.changeDocument(FOLDER, FILE_A, version);
    clock.advance(DEBOUNCE_MS);
    await runner.answer(`answer ${version}`);
  }
  assert.equal(published.length, 3);
});

test('an edit made during a check whose debounce is still counting waits for the timer', async () => {
  const { scheduler, clock, runner } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');

  scheduler.changeDocument(FOLDER, FILE_A, 2);
  await runner.answer('first');
  assert.equal(runner.jobs.length, 1, 'the timer has not fired yet');

  clock.advance(DEBOUNCE_MS);
  assert.equal(runner.jobs.length, 2);
});

test('a close while a check runs is held until it ends, and the folder stays', () => {
  const { scheduler, runner } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.openDocument(FOLDER, FILE_B, 4);
  scheduler.setEngineStatus(FOLDER, 'ready');
  assert.deepEqual(runner.jobs[0]?.versions, { [FILE_A]: 1, [FILE_B]: 4 });

  scheduler.closeDocument(FOLDER, FILE_B);
  assert.equal(scheduler.hasFolder(FOLDER), true);
  assert.equal(runner.jobs.length, 1, 'held until the running check ends');
});

test('a closed document in the workspace keeps the folder and analyzes the disk content at once', async () => {
  const { scheduler, runner, released } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');
  await runner.answer('first');

  scheduler.closeDocument(FOLDER, FILE_A);
  assert.equal(runner.jobs.length, 2);
  assert.deepEqual(runner.jobs[1]?.versions, {});
  assert.deepEqual(released, []);
  assert.equal(scheduler.hasFolder(FOLDER), true);
});

test('file changes analyze after the debounce, and are ignored for folders that were never opened', async () => {
  const { scheduler, clock, runner } = createHarness();
  scheduler.fileChanged('C:/Work/Never');
  assert.equal(clock.pendingTimerCount, 0);

  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');
  await runner.answer('first');
  scheduler.fileChanged(FOLDER);
  assert.equal(runner.jobs.length, 1);

  clock.advance(DEBOUNCE_MS);
  assert.equal(runner.jobs.length, 2);
});

test('a file change of a folder with a state reports pending at once and checks after the debounce', async () => {
  const { scheduler, clock, runner, results } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');
  await runner.answer('first');
  results.length = 0;

  scheduler.fileChanged(FOLDER);
  assert.deepEqual(results, [{ folder: FOLDER, state: 'pending' }]);
  assert.equal(runner.jobs.length, 1);

  clock.advance(DEBOUNCE_MS - 1);
  assert.equal(runner.jobs.length, 1);
  clock.advance(1);
  assert.equal(runner.jobs.length, 2);
});

test('a file change of a folder that never had a document open reports nothing and starts no timer', () => {
  const { scheduler, clock, runner, results } = createHarness();
  scheduler.fileChanged('C:/Work/Never');
  assert.deepEqual(results, []);
  assert.equal(clock.pendingTimerCount, 0);
  assert.equal(runner.jobs.length, 0);
  assert.equal(scheduler.hasFolder('C:/Work/Never'), false);
});

test('the last close of a folder outside the workspace lets it go without a check', () => {
  const { scheduler, runner, released, results } = createHarness();
  scheduler.openDocument(OTHER_FOLDER, 'file:///d%3A/Elsewhere/Two/X.verse', 1);
  scheduler.setEngineStatus(OTHER_FOLDER, 'ready');
  assert.equal(runner.jobs.length, 1);

  scheduler.closeDocument(OTHER_FOLDER, 'file:///d%3A/Elsewhere/Two/X.verse');
  assert.deepEqual(runner.cancelled, [OTHER_FOLDER], 'the running check is killed');
  assert.deepEqual(released, [[OTHER_FOLDER, 'closed']]);
  assert.equal(runner.jobs.length, 1);
  assert.equal(scheduler.hasFolder(OTHER_FOLDER), false);
  assert.equal(results.at(-1)?.state, 'pending');
});

test('an answer that arrives after the folder was let go is dropped', async () => {
  const { scheduler, runner, published } = createHarness();
  scheduler.openDocument(OTHER_FOLDER, 'file:///d%3A/Elsewhere/Two/X.verse', 1);
  scheduler.setEngineStatus(OTHER_FOLDER, 'ready');
  scheduler.closeDocument(OTHER_FOLDER, 'file:///d%3A/Elsewhere/Two/X.verse');

  await runner.answer('late');
  assert.deepEqual(published, []);
});

test('a folder that is tracked again after being let go is not affected by the old answer', async () => {
  const { scheduler, runner, published } = createHarness();
  const documentUri = 'file:///d%3A/Elsewhere/Two/X.verse';
  scheduler.openDocument(OTHER_FOLDER, documentUri, 1);
  scheduler.setEngineStatus(OTHER_FOLDER, 'ready');
  scheduler.closeDocument(OTHER_FOLDER, documentUri);
  scheduler.openDocument(OTHER_FOLDER, documentUri, 1);
  scheduler.setEngineStatus(OTHER_FOLDER, 'ready');
  assert.equal(runner.jobs.length, 2);

  await runner.answer('stale');
  assert.deepEqual(published, [], 'the first job belonged to the previous state');

  await runner.answer('fresh');
  assert.deepEqual(published, [[OTHER_FOLDER, 2, 'fresh']]);
});

test('generations grow with every check that is started, not with edits', () => {
  const { scheduler, clock, runner } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');
  scheduler.changeDocument(FOLDER, FILE_A, 2);
  scheduler.changeDocument(FOLDER, FILE_A, 3);
  clock.advance(DEBOUNCE_MS);
  assert.deepEqual(runner.jobs.map((job) => job.generation), [1]);

  scheduler.openDocument(OTHER_FOLDER, 'file:///d%3A/Elsewhere/Two/X.verse', 1);
  scheduler.setEngineStatus(OTHER_FOLDER, 'ready');
  assert.deepEqual(runner.jobs.map((job) => job.generation), [1, 2]);
});

test('pending is sent as soon as a trigger arrives and only once while it stays pending', () => {
  const { scheduler, results } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.changeDocument(FOLDER, FILE_A, 2);
  scheduler.fileChanged(FOLDER);
  assert.deepEqual(results, [{ folder: FOLDER, state: 'pending' }]);
});

test('ok carries the versions that the check used, and stays pending while another check is owed', async () => {
  const { scheduler, clock, runner, results } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');
  scheduler.changeDocument(FOLDER, FILE_A, 2);
  clock.advance(DEBOUNCE_MS);

  await runner.answer('first');
  assert.deepEqual(results.map((result) => result.state), ['pending'], 'no ok while another check is owed');

  await runner.answer('second');
  assert.deepEqual(results.at(-1), { folder: FOLDER, state: 'ok', versions: { [FILE_A]: 2 } });
});

test('a failed check publishes undefined to clear the diagnostics and reports failed', async () => {
  const { scheduler, runner, published, results } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');

  await runner.fail('timeout');
  assert.deepEqual(published, [[FOLDER, 1, undefined]]);
  assert.deepEqual(results.at(-1), { folder: FOLDER, state: 'failed' });
});

test('a runner that throws is treated as a failed check', async () => {
  const published: [string, number, string | undefined][] = [];
  const results: CheckResult[] = [];
  const throwingScheduler = new CheckScheduler<string>({
    clock: new FakeClock(),
    runner: {
      run: () => {
        throw new Error('boom');
      },
      cancel: () => {},
    },
    isInsideWorkspace: () => true,
    onPublish: (folder, generation, response) => {
      published.push([folder, generation, response]);
    },
    onCheckResult: (result) => {
      results.push(result);
    },
    onFolderReleased: () => {},
    log: () => {},
  });

  throwingScheduler.openDocument(FOLDER, FILE_A, 1);
  throwingScheduler.setEngineStatus(FOLDER, 'ready');
  await flush();
  assert.deepEqual(published, [[FOLDER, 1, undefined]]);
  assert.equal(results.at(-1)?.state, 'failed');
});

test('shutdown kills every running check and clears the timers', () => {
  const { scheduler, clock, runner } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');
  scheduler.openDocument(OTHER_FOLDER, 'file:///d%3A/Elsewhere/Two/X.verse', 1);
  scheduler.setEngineStatus(OTHER_FOLDER, 'ready');
  scheduler.changeDocument(FOLDER, FILE_A, 2);

  scheduler.shutdown();
  assert.deepEqual([...runner.cancelled].sort(), [FOLDER, OTHER_FOLDER]);
  assert.equal(clock.pendingTimerCount, 0);
  assert.deepEqual(scheduler.getTrackedFolders(), []);
});

test('releasing a folder kills its check, forgets it and reports it', () => {
  const { scheduler, runner, released } = createHarness();
  scheduler.openDocument(FOLDER, FILE_A, 1);
  scheduler.setEngineStatus(FOLDER, 'ready');

  scheduler.releaseFolder(FOLDER);
  assert.deepEqual(runner.cancelled, [FOLDER]);
  assert.deepEqual(released, [[FOLDER, 'requested']]);
  assert.equal(scheduler.hasFolder(FOLDER), false);
});

test('folder paths are matched ignoring case and separators', () => {
  const { scheduler, runner } = createHarness();
  scheduler.openDocument('C:\\Work\\One', FILE_A, 1);
  scheduler.setEngineStatus('c:/work/one', 'ready');
  assert.equal(runner.jobs.length, 1);
  assert.equal(runner.jobs[0]?.folder, 'C:/Work/One');
});

test('at the folder limit the oldest folder without open documents is let go', () => {
  const { scheduler, released } = createHarness(2);
  scheduler.openDocument('C:/Work/A', 'file:///a', 1);
  scheduler.openDocument('C:/Work/B', 'file:///b', 1);
  scheduler.closeDocument('C:/Work/A', 'file:///a');
  scheduler.closeDocument('C:/Work/B', 'file:///b');

  assert.equal(scheduler.openDocument('C:/Work/C', 'file:///c', 1), true);
  assert.deepEqual(released, [['C:/Work/A', 'limit']]);
  assert.deepEqual(scheduler.getTrackedFolders().sort(), ['C:/Work/B', 'C:/Work/C']);
});

test('at the folder limit with every folder in use the new folder is refused', () => {
  const { scheduler, released } = createHarness(2);
  scheduler.openDocument('C:/Work/A', 'file:///a', 1);
  scheduler.openDocument('C:/Work/B', 'file:///b', 1);

  assert.equal(scheduler.openDocument('C:/Work/C', 'file:///c', 1), false);
  assert.deepEqual(released, []);
  assert.equal(scheduler.hasFolder('C:/Work/C'), false);
});

test('the default limit is 64 folders', () => {
  const { scheduler } = createHarness();
  for (let index = 0; index < 64; index += 1) {
    assert.equal(scheduler.openDocument(`C:/Work/F${index}`, `file:///f${index}`, 1), true);
  }
  assert.equal(scheduler.openDocument('C:/Work/Extra', 'file:///extra', 1), false);
});
