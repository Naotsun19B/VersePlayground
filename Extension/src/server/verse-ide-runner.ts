// Copyright (c) 2026 Naotsun

/*
 * Runs `verse.exe --ide-request`: one process per request. The request goes to stdin as JSON, the answer is the one
 * stdout line that starts with the protocol prefix. This file owns everything about the process: spawning, reading the
 * answer, the timeout, killing a process that lingers after answering, and the limit on concurrent processes.
 * It knows nothing about folders, documents or engines. The command is injected so that tests can run a fake exe.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import {
  encodeRequest,
  extractResponseLine,
  parseResponse,
  type IdeRequest,
  type IdeSuccess,
} from './ide-protocol.ts';

/** A request that has not answered after this long is killed. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** A process that has answered but does not exit within this time is killed. */
export const DEFAULT_KILL_DELAY_MS = 2_000;

/** Number of processes that may run at the same time. */
export const DEFAULT_TOTAL_SLOTS = 4;

/** Number of the slots that only hover and definition requests may use, so that typing never blocks them. */
export const DEFAULT_LOOKUP_RESERVED_SLOTS = 1;

/** Largest amount of stdout, in bytes, that is accepted from one process. */
export const DEFAULT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;

/** Largest amount of stderr, in bytes, that is kept from one process. The rest is dropped. */
export const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

/** The part of stderr that is reported with a failure. */
const STDERR_REPORT_BYTES = 4096;

/** The byte value of "\n". */
const NEWLINE_BYTE = 0x0a;

/** How to start the process and how many of them may run. */
export interface RunnerOptions {
  /** Program to start. In production this is verse.exe; in tests it is the Node executable. */
  command: string;

  /** Arguments of the program. In production this is `['--ide-request']`. */
  args: readonly string[];

  /** Time a request may take before it is killed. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;

  /** Time a process may linger after answering before it is killed. Defaults to DEFAULT_KILL_DELAY_MS. */
  killDelayMs?: number;

  /**
   * The slots the processes of this runner use. Runners that are given the same pool share its limit. Without it the
   * runner makes a pool of its own from totalSlots and lookupReservedSlots.
   */
  slots?: ProcessSlots;

  /** Number of processes that may run at once in the pool of its own. Defaults to DEFAULT_TOTAL_SLOTS. */
  totalSlots?: number;

  /** Number of the slots kept for hover and definition in the pool of its own. Defaults to DEFAULT_LOOKUP_RESERVED_SLOTS. */
  lookupReservedSlots?: number;

  /** Largest stdout accepted from one process. Defaults to DEFAULT_MAX_STDOUT_BYTES. */
  maxStdoutBytes?: number;

  /** Largest stderr kept from one process. Defaults to DEFAULT_MAX_STDERR_BYTES. */
  maxStderrBytes?: number;
}

/** The outcome of one run. Every failure is a value; the promise returned by `run` never rejects. */
export type RunOutcome =
  | {
    /** The process answered and the answer is valid. */
    status: 'ok';

    /** The answer. */
    response: IdeSuccess;
  }
  | {
    /** The process answered that it refused the request. */
    status: 'rejected';

    /** The reason it gave. */
    error: string;
  }
  | {
    /** The process speaks another protocol version. */
    status: 'protocolMismatch';

    /** The version it reported. */
    protocol: unknown;
  }
  | {
    /** The answer line is malformed. */
    status: 'invalid';

    /** What is wrong with it. */
    error: string;
  }
  | {
    /** The process could not be started (for example, the file does not exist). */
    status: 'spawnFailed';

    /** The error code, such as "ENOENT", when there is one. */
    code: string | undefined;

    /** The error message. */
    error: string;
  }
  | {
    /** The process ended without an answer line. An old verse.exe that does not know the flag ends like this. */
    status: 'noResponse';

    /** The exit code, or null when the process was killed by a signal. */
    exitCode: number | null;

    /** The beginning of stderr. */
    stderr: string;

    /** The error of writing the request to stdin (such as EPIPE), when it failed. */
    stdinError: string | undefined;
  }
  | {
    /** The process did not answer in time and was killed. */
    status: 'timeout';

    /** The beginning of stderr. */
    stderr: string;
  }
  | {
    /** The process wrote more to stdout than is accepted and was killed. */
    status: 'outputTooLarge';

    /** What happened. */
    error: string;
  }
  | {
    /** The request is over the size limit, so no process was started. */
    status: 'requestTooLarge';

    /** What happened. */
    error: string;
  }
  | {
    /** The run was cancelled before it started or while it ran. */
    status: 'cancelled';
  };

/** A request that is waiting for a slot or running. */
interface RunEntry {
  // UTF-8 body to write to stdin.
  body: Buffer;

  // Whether the request is a hover or definition, which may use the reserved slot.
  isLookup: boolean;

  // Whether a process has been started for this entry.
  isStarted: boolean;

  // Whether the promise of the entry has been resolved.
  isSettled: boolean;

  // Resolves the promise of the entry once and detaches the abort listener.
  settle: (outcome: RunOutcome) => void;

  // Starts the process of the entry. Called by the slot pool when a slot is free for it.
  start: () => void;

  // Cancels the entry: removes it from the queue, or kills its process.
  cancel: () => void;
}

/**
 * The limit on concurrent processes: a total, of which some slots are kept for hover and definition. One pool can be
 * shared by several runners, so that the limit holds for all of them together.
 */
export class ProcessSlots {
  /** Number of processes that may run at the same time. */
  private readonly totalSlots: number;

  /** Number of the slots that only hover and definition requests may use. */
  private readonly lookupReservedSlots: number;

  /** Entries that wait for a hover or definition slot, oldest first. */
  private readonly lookupQueue: RunEntry[] = [];

  /** Entries that wait for a check slot, oldest first. */
  private readonly checkQueue: RunEntry[] = [];

  /** Entries that hold a slot, that is, whose process has not closed yet. */
  private readonly runningEntries = new Set<RunEntry>();

  /** Number of running entries that are not lookups. */
  private runningCheckCount = 0;

  /**
   * Creates a pool.
   *
   * @param totalSlots Number of processes that may run at the same time.
   * @param lookupReservedSlots Number of the slots that only hover and definition requests may use.
   */
  public constructor(
    totalSlots: number = DEFAULT_TOTAL_SLOTS,
    lookupReservedSlots: number = DEFAULT_LOOKUP_RESERVED_SLOTS,
  ) {
    this.totalSlots = totalSlots;
    this.lookupReservedSlots = lookupReservedSlots;
  }

  /** Number of slots in use. A slot is returned when its process has closed, not when it was told to die. */
  public get runningCount(): number {
    return this.runningEntries.size;
  }

  /** Number of requests that wait for a slot. */
  public get queuedCount(): number {
    return this.lookupQueue.length + this.checkQueue.length;
  }

  /** Puts an entry in line and starts it at once when a slot is free. */
  public enqueue(entry: RunEntry): void {
    (entry.isLookup ? this.lookupQueue : this.checkQueue).push(entry);
    this.dispatch();
  }

  /** Removes an entry from the waiting queues, if it is there. */
  public removeFromQueue(entry: RunEntry): void {
    for (const queue of [this.lookupQueue, this.checkQueue]) {
      const index = queue.indexOf(entry);
      if (index >= 0) {
        queue.splice(index, 1);
      }
    }
  }

  /** Returns the slot of an entry whose process has closed, and starts the next waiting entries. */
  public release(entry: RunEntry): void {
    if (this.runningEntries.delete(entry) && !entry.isLookup) {
      this.runningCheckCount -= 1;
    }
    this.dispatch();
  }

  /** Cancels every waiting request and kills every running process of every runner that uses the pool. */
  public cancelAll(): void {
    for (const entry of [...this.lookupQueue, ...this.checkQueue, ...this.runningEntries]) {
      entry.cancel();
    }
  }

  /** Starts waiting entries for as long as there are free slots. Lookups go first. */
  private dispatch(): void {
    while (this.runningEntries.size < this.totalSlots) {
      const checkSlots = this.totalSlots - this.lookupReservedSlots;
      const canStartCheck = (this.runningCheckCount < checkSlots);
      const entry = this.lookupQueue.shift() ?? (canStartCheck ? this.checkQueue.shift() : undefined);
      if (entry === undefined) {
        return;
      }

      this.runningEntries.add(entry);
      if (!entry.isLookup) {
        this.runningCheckCount += 1;
      }
      entry.start();
    }
  }
}

/** Runs verse.exe analysis requests with a bounded number of concurrent processes. */
export class VerseIdeRunner {
  /** Fixed settings of this runner, with the defaults filled in. */
  private readonly settings: Readonly<Omit<Required<RunnerOptions>, 'slots' | 'totalSlots' | 'lookupReservedSlots'>>;

  /** The slots that limit the processes of this runner, possibly shared with other runners. */
  private readonly slots: ProcessSlots;

  /** Creates a runner. No process is started until `run` is called. */
  public constructor(options: Readonly<RunnerOptions>) {
    this.settings = {
      command: options.command,
      args: options.args,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      killDelayMs: options.killDelayMs ?? DEFAULT_KILL_DELAY_MS,
      maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES,
      maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    };
    this.slots = options.slots ?? new ProcessSlots(options.totalSlots, options.lookupReservedSlots);
  }

  /** Number of slots in use in the pool of this runner, which counts the processes of every runner that shares it. */
  public get runningCount(): number {
    return this.slots.runningCount;
  }

  /** Number of requests that wait for a slot in the pool of this runner. */
  public get queuedCount(): number {
    return this.slots.queuedCount;
  }

  /**
   * Sends one request to a new verse.exe process and returns the outcome.
   *
   * Hover and definition requests may use every slot; every other request may use all but the reserved ones.
   * The answer is taken as soon as its line arrives, without waiting for the process to exit.
   * Aborting the signal removes a waiting request or kills the running process, and resolves with "cancelled".
   */
  public run(request: Readonly<IdeRequest>, signal?: AbortSignal): Promise<RunOutcome> {
    const encoded = encodeRequest(request);
    if (!encoded.isOk) {
      return Promise.resolve({ status: 'requestTooLarge', error: encoded.error });
    }

    if (signal?.aborted === true) {
      return Promise.resolve({ status: 'cancelled' });
    }

    return new Promise<RunOutcome>((resolve) => {
      const onAbort = (): void => {
        entry.cancel();
      };
      const entry: RunEntry = {
        body: encoded.body,
        isLookup: (request.kind === 'hover' || request.kind === 'definition'),
        isStarted: false,
        isSettled: false,
        start: (): void => {
          this.launch(entry);
        },
        settle: (outcome: RunOutcome): void => {
          if (entry.isSettled) {
            return;
          }
          entry.isSettled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(outcome);
        },
        cancel: (): void => {
          this.slots.removeFromQueue(entry);
          entry.settle({ status: 'cancelled' });
        },
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.slots.enqueue(entry);
    });
  }

  /**
   * Cancels every waiting request and kills every running process of the pool of this runner, including those of the
   * runners that share it. The runner can be used again afterwards.
   */
  public cancelAll(): void {
    this.slots.cancelAll();
  }

  /** Starts the process of an entry, whose slot the pool has already counted, and wires everything that ends it. */
  private launch(entry: RunEntry): void {
    entry.isStarted = true;

    // State of this one process.
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let isClosed = false;
    let isReleased = false;
    let stdinError: string | undefined;
    let stdoutBytes = 0;
    let lineChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    const release = (): void => {
      if (isReleased) {
        return;
      }
      isReleased = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      this.slots.release(entry);
    };

    const getStderrText = (): string => {
      return Buffer.concat(stderrChunks).subarray(0, STDERR_REPORT_BYTES).toString('utf8');
    };

    let child: ChildProcess;
    try {
      child = spawn(this.settings.command, [...this.settings.args], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      entry.settle({ status: 'spawnFailed', code: getErrorCode(error), error: String(error) });
      release();
      return;
    }

    // The entry is finished with this outcome and the process, if it is still alive, is killed.
    const stop = (outcome: RunOutcome): void => {
      entry.settle(outcome);
      clearTimeout(timeoutTimer);
      if (!isClosed) {
        child.kill();
      }
    };
    entry.cancel = (): void => {
      stop({ status: 'cancelled' });
    };

    // Takes a finished stdout line. Returns whether it was the answer, in which case the entry is settled.
    const handleLine = (lineBytes: Buffer): boolean => {
      const responseJson = extractResponseLine(lineBytes.toString('utf8').replace(/\r$/, ''));
      if (responseJson === undefined) {
        return false;
      }

      const parsed = parseResponse(responseJson);
      if (parsed.status === 'ok') {
        entry.settle({ status: 'ok', response: parsed.response });
      } else if (parsed.status === 'rejected') {
        entry.settle({ status: 'rejected', error: parsed.error });
      } else if (parsed.status === 'protocolMismatch') {
        entry.settle({ status: 'protocolMismatch', protocol: parsed.protocol });
      } else {
        entry.settle({ status: 'invalid', error: parsed.error });
      }

      // The answer is in. A process that does not exit by itself is not waited for.
      clearTimeout(timeoutTimer);
      if (!isClosed) {
        killTimer = setTimeout(() => {
          child.kill();
        }, this.settings.killDelayMs);
      }
      return true;
    };

    // Splits stdout into lines at "\n". Bytes are kept until the line is complete, so that a character that is split
    // between two chunks is decoded whole.
    const consumeStdout = (chunk: Buffer): void => {
      let rest = chunk;
      while (rest.length > 0) {
        const newlineIndex = rest.indexOf(NEWLINE_BYTE);
        if (newlineIndex < 0) {
          lineChunks.push(rest);
          return;
        }

        lineChunks.push(rest.subarray(0, newlineIndex));
        const lineBytes = Buffer.concat(lineChunks);
        lineChunks = [];
        rest = rest.subarray(newlineIndex + 1);
        if (handleLine(lineBytes)) {
          return;
        }
      }
    };

    // Streams are always drained, even after the answer, so that the process never blocks on a full pipe.
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > this.settings.maxStdoutBytes) {
        stop({
          status: 'outputTooLarge',
          error: `The process wrote more than ${this.settings.maxStdoutBytes} bytes to stdout.`,
        });
        return;
      }

      if (!entry.isSettled) {
        consumeStdout(chunk);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < this.settings.maxStderrBytes) {
        stderrChunks.push(chunk.subarray(0, this.settings.maxStderrBytes - stderrBytes));
        stderrBytes += chunk.length;
      }
    });

    // Without these handlers an error event on a stream would take the whole server down.
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);
    child.stdin?.on('error', (stdinFailure: Error) => {
      stdinError = String(stdinFailure);
    });
    child.on('error', (processError: Error) => {
      // An error before the process exists means it never started and no close event is worth waiting for.
      if (child.pid === undefined) {
        entry.settle({ status: 'spawnFailed', code: getErrorCode(processError), error: String(processError) });
        release();
        return;
      }
      stop({ status: 'spawnFailed', code: getErrorCode(processError), error: String(processError) });
    });
    child.on('close', (exitCode: number | null) => {
      isClosed = true;

      // The last line may lack its line terminator. Look at it before giving up.
      if (!entry.isSettled && lineChunks.length > 0) {
        handleLine(Buffer.concat(lineChunks));
      }

      entry.settle({ status: 'noResponse', exitCode, stderr: getStderrText(), stdinError });
      release();
    });

    timeoutTimer = setTimeout(() => {
      stop({ status: 'timeout', stderr: getStderrText() });
    }, this.settings.timeoutMs);

    child.stdin?.end(entry.body);
  }
}

/** Returns the `code` of a Node error such as "ENOENT", or undefined when the value has none. */
function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}
