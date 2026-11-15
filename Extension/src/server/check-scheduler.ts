// Copyright (c) 2026 Naotsun

/*
 * Decides when the language server analyzes a folder.
 *
 * Every folder is one Verse program with its own small state machine: edits are debounced, opening and closing a
 * document is acted on at once, at most one analysis runs per folder while at most one more waits, and the answer of a
 * run is published only when it is newer than the last one that was published. The scheduler knows nothing about
 * processes, the file system or LSP: the clock, the runner and all outputs are passed in, so it can be tested with a
 * fake clock and a fake runner.
 */

import { normalizePath, toComparisonKey } from '../shared/program-paths.ts';
import type { CheckResult, CheckState, VersionMap } from '../shared/protocol-types.ts';

/** Quiet time after the last edit before the folder is analyzed, in milliseconds. */
export const DEBOUNCE_MS = 300;

/** Largest number of folders that keep a state at the same time. */
export const MAX_TRACKED_FOLDERS = 64;

/** A clock that can be replaced by a fake one. */
export interface SchedulerClock {
  /** Calls `callback` once after `delayMs` milliseconds and returns a handle for `clearTimer`. */
  setTimer(callback: () => void, delayMs: number): unknown;

  /** Cancels a timer that has not fired yet. */
  clearTimer(handle: unknown): void;
}

/** The clock of the running process. */
export const SYSTEM_CLOCK: SchedulerClock = {
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** One analysis that the scheduler asks the runner to perform. */
export interface CheckJob {
  /** The folder to analyze, with "/" separators. */
  folder: string;

  /** Number of this analysis. Larger numbers are newer, across all folders. */
  generation: number;

  /** The version of every open document of the folder at the moment the analysis was started. */
  versions: VersionMap;
}

/** What came back from one analysis. */
export type CheckOutcome<TResponse> =
  | {
    /** verse.exe answered. */
    isOk: true;

    /** The answer, in whatever form the runner produces. */
    response: TResponse;
  }
  | {
    /** The analysis failed: no answer, a refused request or a timeout. */
    isOk: false;

    /** What went wrong, for the log. */
    error: string;
  };

/** Performs analyses. The scheduler never looks inside the answer. */
export interface CheckRunner<TResponse> {
  /**
   * Starts one analysis and resolves with its outcome. It is called synchronously from the scheduler's own call, so
   * the texts of the open documents it reads are the ones that match `job.versions`.
   */
  run(job: Readonly<CheckJob>): Promise<CheckOutcome<TResponse>>;

  /** Kills the analysis of a folder that is running, if any. Its promise may then resolve with a failure. */
  cancel(folder: string): void;
}

/** Why the scheduler stopped tracking a folder. */
export type ReleaseReason = 'closed' | 'limit' | 'requested';

/** Whether the engine of a folder can be used yet. */
export type EngineStatus = 'waiting' | 'ready' | 'unusable';

/** Everything the scheduler is connected to. */
export interface CheckSchedulerOptions<TResponse> {
  /** Time source for the debounce. */
  clock: SchedulerClock;

  /** Performs the analyses. */
  runner: CheckRunner<TResponse>;

  /** Whether a folder belongs to the workspace. Folders outside it are let go when their last document closes. */
  isInsideWorkspace(folder: string): boolean;

  /** Receives the answer of the newest finished analysis, or undefined when it failed, which clears the diagnostics. */
  onPublish(folder: string, generation: number, response: TResponse | undefined): void;

  /** Receives every change of the state of a folder. */
  onCheckResult(result: CheckResult): void;

  /** Called after a folder was let go, so that its diagnostics, file watcher and engine cache can be dropped. */
  onFolderReleased(folder: string, reason: ReleaseReason): void;

  /** Writes a line to the output channel. */
  log(message: string): void;
}

/** What the scheduler keeps for one folder. */
interface FolderState {
  // The folder with "/" separators.
  folder: string;

  // Whether the folder belongs to the workspace, decided when the state was created.
  isInsideWorkspace: boolean;

  // Open documents of the folder: version by URI string.
  documents: Map<string, number>;

  // True while content changed after the latest analysis was started, which means another one is owed.
  isDirty: boolean;

  // Handle of the debounce timer, or undefined when none is running.
  debounceHandle: unknown;

  // Generation of the analysis that is running, or undefined when none is.
  runningGeneration: number | undefined;

  // Generation of the newest analysis whose answer was published.
  lastPublishedGeneration: number;

  // Whether the engine's verse.exe is known to be usable. Analyses wait until it is.
  engineStatus: EngineStatus;

  // The state that was last reported to the client, which keeps "pending" from being sent twice.
  notifiedState: CheckState | undefined;

  // Order of the latest activity, which decides the folder to let go of when there are too many.
  lastTouch: number;
}

/** Schedules the analyses of all folders of the window. */
export class CheckScheduler<TResponse> {
  /** States by the comparison key of the folder. */
  private readonly states = new Map<string, FolderState>();

  /** Source of the generation numbers. */
  private lastGeneration = 0;

  /** Source of the activity order. */
  private touchCounter = 0;

  /** The connections of the scheduler. */
  private readonly options: Readonly<CheckSchedulerOptions<TResponse>>;

  /** The most states that may exist at once. */
  private readonly maxFolders: number;

  /**
   * Creates a scheduler that tracks no folder yet.
   *
   * @param options The connections of the scheduler.
   * @param maxFolders The most folders that may be tracked at once.
   */
  public constructor(options: Readonly<CheckSchedulerOptions<TResponse>>, maxFolders: number = MAX_TRACKED_FOLDERS) {
    this.options = options;
    this.maxFolders = maxFolders;
  }

  /**
   * A document was opened. Analyzes the folder at once.
   *
   * @returns False when the folder is not tracked because the window is at its limit of folders and none can be let go.
   */
  public openDocument(folder: string, documentUri: string, version: number): boolean {
    const state = this.getOrCreateState(folder);
    if (state === undefined) {
      return false;
    }

    state.documents.set(documentUri, version);
    this.requestCheck(state, true);
    return true;
  }

  /**
   * The content of a document changed. Analyzes the folder after the debounce time.
   * A change that carries the version that is already known is ignored (a client may report the open as a change).
   */
  public changeDocument(folder: string, documentUri: string, version: number): void {
    const state = this.getOrCreateState(folder);
    if (state === undefined) {
      return;
    }

    if (state.documents.get(documentUri) === version) {
      return;
    }

    state.documents.set(documentUri, version);
    this.requestCheck(state, false);
  }

  /**
   * A document was closed, so the folder now reads it from the disk again. Analyzes at once, except that a folder
   * outside the workspace whose last document closed is let go without an analysis.
   */
  public closeDocument(folder: string, documentUri: string): void {
    const state = this.states.get(toComparisonKey(folder));
    if (state === undefined || !state.documents.delete(documentUri)) {
      return;
    }

    if (state.documents.size === 0 && !state.isInsideWorkspace) {
      this.release(state, 'closed');
      return;
    }

    this.touch(state);
    this.requestCheck(state, true);
  }

  /**
   * A .verse file of the folder was created, changed or deleted on disk. Analyzes after the debounce time.
   * Folders that never had a document open are ignored, so that a bulk change does not start many analyses.
   */
  public fileChanged(folder: string): void {
    const state = this.states.get(toComparisonKey(folder));
    if (state === undefined) {
      return;
    }

    this.requestCheck(state, false);
  }

  /**
   * Tells the scheduler whether the engine of the folder can be used. While it is "waiting" the requests are only
   * remembered; "ready" starts the analysis that is owed; "unusable" drops it and reports the folder as failed.
   */
  public setEngineStatus(folder: string, engineStatus: EngineStatus): void {
    const state = this.states.get(toComparisonKey(folder));
    if (state === undefined) {
      return;
    }

    state.engineStatus = engineStatus;
    if (engineStatus === 'ready') {
      this.tryStart(state);
      return;
    }

    if (engineStatus === 'unusable') {
      state.isDirty = false;
      this.clearDebounce(state);
      this.notify(state, 'failed');
    }
  }

  /** Lets go of a folder: kills its analysis, forgets its state and reports it through `onFolderReleased`. */
  public releaseFolder(folder: string): void {
    const state = this.states.get(toComparisonKey(folder));
    if (state !== undefined) {
      this.release(state, 'requested');
    }
  }

  /** Returns whether the folder has a state. */
  public hasFolder(folder: string): boolean {
    return this.states.has(toComparisonKey(folder));
  }

  /** Returns whether any document of the folder is open. */
  public hasOpenDocuments(folder: string): boolean {
    const state = this.states.get(toComparisonKey(folder));
    return (state !== undefined && state.documents.size > 0);
  }

  /** Returns the folders that have a state. */
  public getTrackedFolders(): string[] {
    return [...this.states.values()].map((state) => state.folder);
  }

  /** Kills every running analysis and forgets every folder, without reporting anything. For the server's exit. */
  public shutdown(): void {
    for (const state of this.states.values()) {
      this.clearDebounce(state);
      if (state.runningGeneration !== undefined) {
        this.options.runner.cancel(state.folder);
      }
    }
    this.states.clear();
  }

  /** Returns the state of the folder, creating it (and letting go of the oldest idle folder if needed). */
  private getOrCreateState(folder: string): FolderState | undefined {
    const key = toComparisonKey(folder);
    const existingState = this.states.get(key);
    if (existingState !== undefined) {
      this.touch(existingState);
      return existingState;
    }

    if (this.states.size >= this.maxFolders && !this.makeRoom()) {
      this.options.log(`Not analyzing ${normalizePath(folder)}: ${this.maxFolders} folders are already in use.`);
      return undefined;
    }

    const normalizedFolder = normalizePath(folder);
    const newState: FolderState = {
      folder: normalizedFolder,
      isInsideWorkspace: this.options.isInsideWorkspace(normalizedFolder),
      documents: new Map<string, number>(),
      isDirty: false,
      debounceHandle: undefined,
      runningGeneration: undefined,
      lastPublishedGeneration: 0,
      engineStatus: 'waiting',
      notifiedState: undefined,
      lastTouch: 0,
    };
    this.touch(newState);
    this.states.set(key, newState);
    return newState;
  }

  /** Lets go of the least recently used folder that has no open document. Returns false when there is none. */
  private makeRoom(): boolean {
    let victim: FolderState | undefined;
    for (const state of this.states.values()) {
      if (state.documents.size === 0 && (victim === undefined || state.lastTouch < victim.lastTouch)) {
        victim = state;
      }
    }

    if (victim === undefined) {
      return false;
    }

    this.options.log(`Letting go of ${victim.folder} because ${this.maxFolders} folders are in use.`);
    this.release(victim, 'limit');
    return true;
  }

  /** Records that the folder was just used. */
  private touch(state: FolderState): void {
    this.touchCounter += 1;
    state.lastTouch = this.touchCounter;
  }

  /** Forgets a folder after killing its analysis. */
  private release(state: FolderState, reason: ReleaseReason): void {
    this.clearDebounce(state);
    this.states.delete(toComparisonKey(state.folder));
    if (state.runningGeneration !== undefined) {
      this.options.runner.cancel(state.folder);
    }
    this.options.onFolderReleased(state.folder, reason);
  }

  /** Cancels the debounce timer of a folder, if any. */
  private clearDebounce(state: FolderState): void {
    if (state.debounceHandle !== undefined) {
      this.options.clock.clearTimer(state.debounceHandle);
      state.debounceHandle = undefined;
    }
  }

  /** Marks the folder as owing an analysis and starts it now or after the debounce time. */
  private requestCheck(state: FolderState, isImmediate: boolean): void {
    // Nothing will ever be analyzed with an unusable engine, so there is nothing to wait for.
    if (state.engineStatus === 'unusable') {
      return;
    }

    state.isDirty = true;
    this.notify(state, 'pending');
    this.clearDebounce(state);
    if (isImmediate) {
      this.tryStart(state);
      return;
    }

    state.debounceHandle = this.options.clock.setTimer(() => {
      state.debounceHandle = undefined;
      this.tryStart(state);
    }, DEBOUNCE_MS);
  }

  /** Starts the owed analysis unless one is running, the debounce is still counting or the engine is not ready. */
  private tryStart(state: FolderState): void {
    if (
      !state.isDirty ||
      state.runningGeneration !== undefined ||
      state.debounceHandle !== undefined ||
      state.engineStatus !== 'ready'
    ) {
      return;
    }

    this.lastGeneration += 1;
    const generation = this.lastGeneration;
    const versions = Object.fromEntries(state.documents);
    state.isDirty = false;
    state.runningGeneration = generation;

    let outcomePromise: Promise<CheckOutcome<TResponse>>;
    try {
      outcomePromise = this.options.runner.run({ folder: state.folder, generation, versions });
    } catch (error) {
      outcomePromise = Promise.resolve({ isOk: false, error: String(error) });
    }

    void outcomePromise.then(
      (outcome) => {
        this.finish(state, generation, versions, outcome);
      },
      (error: unknown) => {
        this.finish(state, generation, versions, { isOk: false, error: String(error) });
      },
    );
  }

  /** Handles the end of an analysis: publishes it if it is the newest, then reports or runs the owed one. */
  private finish(
    state: FolderState,
    generation: number,
    versions: VersionMap,
    outcome: CheckOutcome<TResponse>,
  ): void {
    // A folder that was let go in the meantime (even if it was tracked again since) is not this state any more.
    if (this.states.get(toComparisonKey(state.folder)) !== state) {
      return;
    }

    state.runningGeneration = undefined;
    const isNewest = generation > state.lastPublishedGeneration;
    if (isNewest) {
      state.lastPublishedGeneration = generation;
      if (!outcome.isOk) {
        this.options.log(`The analysis of ${state.folder} failed: ${outcome.error}`);
      }
      this.options.onPublish(state.folder, generation, (outcome.isOk ? outcome.response : undefined));
    }

    if (state.isDirty) {
      // The state stays "pending" while another analysis is owed.
      this.tryStart(state);
      return;
    }

    if (isNewest) {
      this.notify(state, (outcome.isOk ? 'ok' : 'failed'), versions);
    }
  }

  /** Reports the state of a folder to the client, except that "pending" is not repeated. */
  private notify(state: FolderState, checkState: CheckState, versions?: VersionMap): void {
    if (checkState === 'pending' && state.notifiedState === 'pending') {
      return;
    }

    state.notifiedState = checkState;
    const result: CheckResult = { folder: state.folder, state: checkState };
    if (checkState === 'ok' && versions !== undefined) {
      result.versions = versions;
    }
    this.options.onCheckResult(result);
  }
}
