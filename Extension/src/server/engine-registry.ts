// Copyright (c) 2026 Naotsun

/*
 * Decides which engine analyzes a folder, whether the user allows running it, and whether its verse.exe can answer.
 *
 * Three different lifetimes meet here. Which engine a folder uses is cached per folder. Whether the user allows an
 * engine is asked again for every folder, because the answer depends on how the engine was found, and is never cached
 * here. Whether an engine's verse.exe understands the analysis mode is learned by one ping and shared by all folders
 * that use the engine. The file system, the process and the client are passed in, so all of it is testable.
 */

import type { EngineLocation, EngineResolution } from '../shared/engine-locator.ts';
import { toComparisonKey } from '../shared/program-paths.ts';
import type { ApproveEngineParams, UnavailableParams, UnavailableReason } from '../shared/protocol-types.ts';
import { parseResponse } from './ide-protocol.ts';

/** How long a failed ping that may be temporary is not tried again, in milliseconds. */
export const TRANSIENT_FAILURE_SUPPRESSION_MS = 30 * 1000;

/** Finds the engine for a folder. This is `findEngine` of the engine locator. */
export type EngineFinder = (
  configuredEngineDir: string,
  startFolders: readonly string[],
) => EngineResolution | undefined;

/** What running `verse.exe --ide-request` with a ping request led to, as the runner reports it. */
export type PingProcessResult =
  | {
    /** The process printed an answer line. */
    kind: 'answered';

    /** The JSON after the answer prefix. */
    responseJson: string;
  }
  | {
    /** The process ended without an answer line. */
    kind: 'noAnswer';

    /** Its exit code, or undefined when it was killed or the code is unknown. */
    exitCode: number | undefined;
  }
  | {
    /** The process could not be started. */
    kind: 'spawnFailed';

    /** The error code, such as "ENOENT" when the file does not exist. */
    errorCode: string | undefined;

    /** The error message. */
    message: string;
  }
  | {
    /** Anything else that went wrong, such as the timeout. */
    kind: 'failed';

    /** What happened. */
    message: string;
  };

/** What preparing a folder found out. */
export type PrepareResult =
  | {
    /** The folder can be analyzed with this engine. */
    status: 'ready';

    /** The engine to use. */
    location: EngineLocation;
  }
  | {
    /**
     * The folder must not be analyzed until something changes: no engine was found, the user did not allow it, or
     * its verse.exe is known to be unusable.
     */
    status: 'unusable';
  }
  | {
    /** The ping failed in a way that may be temporary, so the next trigger should prepare the folder again. */
    status: 'retryLater';
  };

/** Sends a ping to a verse.exe. It uses the same process slots as the checks. */
export interface PingRunner {
  /** Runs one ping against the given verse.exe. Never rejects. */
  ping(versePath: string): Promise<PingProcessResult>;
}

/** The part of the client that the registry talks to. */
export interface EngineRegistryClient {
  /** Asks whether the engine's verse.exe may be run for the folder. */
  approveEngine(params: Readonly<ApproveEngineParams>): Promise<boolean>;

  /** Tells the client that the analysis cannot be used with the engine. */
  notifyUnavailable(params: Readonly<UnavailableParams>): void;

  /** Writes a line to the output channel. */
  log(message: string): void;
}

/** Everything the registry is connected to. */
export interface EngineRegistryOptions {
  /** The engineDir setting, which may be empty. */
  configuredEngineDir: string;

  /** The workspace folders, which are searched for the local state file after the analyzed folder itself. */
  workspaceFolders: readonly string[];

  /** Finds the engine. */
  findEngine: EngineFinder;

  /** Pings a verse.exe. */
  pingRunner: PingRunner;

  /** The client. */
  client: EngineRegistryClient;

  /** Current time in milliseconds. */
  now(): number;
}

/** What is known about the verse.exe of one engine. */
type PingMemory =
  | {
    // The verse.exe answered the ping with the protocol this build speaks.
    kind: 'usable';
  }
  | {
    // The verse.exe cannot be used, and that will not change until Setup runs again and the server restarts.
    kind: 'unavailable';

    // Why.
    reason: UnavailableReason;
  }
  | {
    // The ping failed in a way that may be temporary.
    kind: 'transient';

    // When the failure happened, in the clock of `now`.
    failedAt: number;
  };

/** The state kept for one engine, found by the comparison key of its folder. */
interface EngineState {
  // What the pings found out, or undefined when no ping finished since the last restart.
  memory: PingMemory | undefined;

  // The ping that is running, which other folders of the same engine wait for.
  inFlightPing: Promise<PingMemory> | undefined;
}

/** A preparation that is running for one folder. */
interface RunningPreparation {
  // Identifies the preparation, so that it can tell whether it is still the one the registry waits for.
  token: object;

  // The result, which other requests for the same folder share.
  promise: Promise<PrepareResult>;
}

/** Resolves folders to engines and keeps what is known about them. */
export class EngineRegistry {
  /** The engine of each folder by its comparison key. A folder without an engine is remembered as undefined. */
  private readonly resolutions = new Map<string, EngineResolution | undefined>();

  /** The engines by the comparison key of their folder. */
  private readonly engines = new Map<string, EngineState>();

  /**
   * The preparation that is running for each folder, which a second request for the same folder waits for. Dropping
   * an entry makes the preparation stale: the next request starts over, and the stale one does not touch the caches.
   */
  private readonly preparations = new Map<string, RunningPreparation>();

  /** The connections of the registry. */
  private readonly options: Readonly<EngineRegistryOptions>;

  /**
   * Creates a registry that knows no engine yet.
   *
   * @param options The connections of the registry.
   */
  public constructor(options: Readonly<EngineRegistryOptions>) {
    this.options = options;
  }

  /**
   * Makes a folder ready to be analyzed: finds its engine, asks for the user's allowance and pings the engine's
   * verse.exe. A request that arrives while the same folder is still being prepared (for example while the user has
   * not answered the confirmation) waits for the running one instead of asking again.
   *
   * @returns The engine to use, or undefined when the folder must not be analyzed (no engine, not allowed, not usable).
   */
  public async prepare(folder: string): Promise<EngineLocation | undefined> {
    const result = await this.prepareFolder(folder);
    return (result.status === 'ready' ? result.location : undefined);
  }

  /**
   * Does what `prepare` does, and also tells why a folder cannot be analyzed, so that a failure that may be temporary
   * can be tried again while a lasting one is not.
   */
  public prepareFolder(folder: string): Promise<PrepareResult> {
    const folderKey = toComparisonKey(folder);
    const runningPreparation = this.preparations.get(folderKey);
    if (runningPreparation !== undefined) {
      return runningPreparation.promise;
    }

    const token = {};
    const promise = this.prepareUncached(folder, folderKey, token).finally(() => {
      // An invalidation may have replaced the entry already, and then it belongs to a newer preparation.
      if (this.preparations.get(folderKey)?.token === token) {
        this.preparations.delete(folderKey);
      }
    });
    this.preparations.set(folderKey, { token, promise });
    return promise;
  }

  /**
   * Forgets which engine the folder uses and drops its running preparation, so that the next preparation searches
   * again.
   */
  public invalidateFolder(folder: string): void {
    const folderKey = toComparisonKey(folder);
    this.resolutions.delete(folderKey);
    this.preparations.delete(folderKey);
  }

  /** Forgets the engine of every folder, for when a local state file of the workspace changed. */
  public invalidateAllFolders(): void {
    this.resolutions.clear();
    this.preparations.clear();
  }

  /** Forgets every engine of every folder and everything the pings found out. For the restart command. */
  public restart(): void {
    this.resolutions.clear();
    this.engines.clear();
    this.preparations.clear();
  }

  /** Returns the engine the folder uses if it is known, without searching or asking. */
  public getKnownEngine(folder: string): EngineLocation | undefined {
    return this.resolutions.get(toComparisonKey(folder))?.location;
  }

  /**
   * The work of `prepare`, once nobody else is already doing it. When an invalidation or a restart happens while it
   * waits, what it found belongs to the old state, so it starts over instead of using or remembering it.
   */
  private async prepareUncached(folder: string, folderKey: string, token: object): Promise<PrepareResult> {
    const resolution = this.resolve(folder, folderKey);
    if (resolution === undefined) {
      return { status: 'unusable' };
    }

    const isApproved = await this.options.client.approveEngine({
      engineDir: resolution.location.engineDir,
      source: resolution.source,
      folder,
    });
    if (this.preparations.get(folderKey)?.token !== token) {
      return this.prepareFolder(folder);
    }

    if (!isApproved) {
      this.options.client.log(`Not analyzing ${folder}: ${resolution.location.versePath} was not allowed.`);
      return { status: 'unusable' };
    }

    const memory = await this.pingEngine(resolution.location);
    if (this.preparations.get(folderKey)?.token !== token) {
      return this.prepareFolder(folder);
    }

    switch (memory.kind) {
      case 'usable':
        return { status: 'ready', location: resolution.location };

      case 'unavailable':
        return { status: 'unusable' };

      case 'transient':
        return { status: 'retryLater' };
    }
  }

  /** Returns the engine of the folder from the cache, or searches for it and caches the answer. */
  private resolve(folder: string, folderKey: string): EngineResolution | undefined {
    if (this.resolutions.has(folderKey)) {
      return this.resolutions.get(folderKey);
    }

    const startFolders = [folder, ...this.options.workspaceFolders];
    const resolution = this.options.findEngine(this.options.configuredEngineDir, startFolders);
    this.resolutions.set(folderKey, resolution);
    if (resolution === undefined) {
      this.options.client.log(`Not analyzing ${folder}: no engine was found for it.`);
    }
    return resolution;
  }

  /** Returns what is known about the engine's verse.exe, pinging it when that is needed and allowed. */
  private async pingEngine(location: Readonly<EngineLocation>): Promise<PingMemory> {
    const engineKey = toComparisonKey(location.engineDir);
    let engineState = this.engines.get(engineKey);
    if (engineState === undefined) {
      engineState = { memory: undefined, inFlightPing: undefined };
      this.engines.set(engineKey, engineState);
    }

    if (engineState.inFlightPing !== undefined) {
      return engineState.inFlightPing;
    }

    const { memory } = engineState;
    if (memory !== undefined && memory.kind !== 'transient') {
      return memory;
    }

    if (memory !== undefined && this.options.now() - memory.failedAt < TRANSIENT_FAILURE_SUPPRESSION_MS) {
      return memory;
    }

    const ping = this.runPing(location, engineState);
    engineState.inFlightPing = ping;
    return ping;
  }

  /** Pings once, classifies the result and remembers it in the engine's state. */
  private async runPing(location: Readonly<EngineLocation>, engineState: EngineState): Promise<PingMemory> {
    let newMemory: PingMemory;
    try {
      const result = await this.options.pingRunner.ping(location.versePath);
      newMemory = this.classify(location, result);
    } catch (error) {
      newMemory = this.toTransientFailure(location, String(error));
    }

    // A restart while the ping was running replaced the state, and then the answer belongs to nobody.
    if (this.engines.get(toComparisonKey(location.engineDir)) === engineState) {
      engineState.memory = newMemory;
      engineState.inFlightPing = undefined;
    }

    if (newMemory.kind === 'unavailable') {
      this.options.client.notifyUnavailable({
        reason: newMemory.reason,
        versePath: location.versePath,
        engineDir: location.engineDir,
      });
    }
    return newMemory;
  }

  /** Turns the outcome of the ping process into what is remembered. */
  private classify(location: Readonly<EngineLocation>, result: Readonly<PingProcessResult>): PingMemory {
    switch (result.kind) {
      case 'answered': {
        const parsed = parseResponse(result.responseJson);
        if (parsed.status === 'ok') {
          return { kind: 'usable' };
        }

        if (parsed.status === 'protocolMismatch') {
          return { kind: 'unavailable', reason: 'protocol' };
        }
        return this.toTransientFailure(location, 'The answer to the ping was not understood.');
      }

      case 'spawnFailed':
        if (result.errorCode === 'ENOENT') {
          return { kind: 'unavailable', reason: 'missing' };
        }
        return this.toTransientFailure(location, result.message);

      case 'noAnswer':
        // An exe without the analysis mode reports the unknown flag and exits with 1. Other endings are accidents.
        if (result.exitCode === 1) {
          return { kind: 'unavailable', reason: 'unsupported' };
        }
        return this.toTransientFailure(location, `The ping ended without an answer (exit code ${result.exitCode}).`);

      case 'failed':
        return this.toTransientFailure(location, result.message);
    }
  }

  /** Logs a failure that may be temporary and returns the memory that suppresses new pings for a while. */
  private toTransientFailure(location: Readonly<EngineLocation>, message: string): PingMemory {
    this.options.client.log(`Pinging ${location.versePath} failed: ${message}`);
    return { kind: 'transient', failedAt: this.options.now() };
  }
}
