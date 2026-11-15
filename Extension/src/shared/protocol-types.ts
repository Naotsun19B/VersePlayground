// Copyright (c) 2026 Naotsun

/*
 * Names and payloads of the custom messages between the extension (client) and the language server. The standard LSP
 * messages are not listed here. This file has no imports so that both sides, and the tests, can use it.
 */

/** Notification from the server: the state of the analysis of one folder changed. */
export const CHECK_RESULT_NOTIFICATION = 'versePlayground/checkResult';

/** Notification from the server: the analysis cannot be used with the engine, so the client should tell the user. */
export const UNAVAILABLE_NOTIFICATION = 'versePlayground/unavailable';

/** Request from the server: may this engine's verse.exe be run? The client answers with a boolean. */
export const APPROVE_ENGINE_REQUEST = 'versePlayground/approveEngine';

/** Document versions by document URI string, as the client's documents are numbered. */
export type VersionMap = Readonly<Record<string, number>>;

/** State of the most recent analysis of a folder. */
export type CheckState = 'pending' | 'ok' | 'failed';

/** Payload of the checkResult notification. */
export interface CheckResult {
  /** The analyzed folder (the program), with "/" separators. */
  folder: string;

  /**
   * "pending" while a change is waiting to be analyzed or an analysis is running with another one queued, "ok" when
   * verse.exe answered for the latest known content (whether or not the code has errors), "failed" when it did not.
   */
  state: CheckState;

  /** For "ok": the version of every open document of the folder that the analysis used, by document URI string. */
  versions?: VersionMap;
}

/** Why the analysis cannot be used with an engine. */
export type UnavailableReason = 'missing' | 'unsupported' | 'protocol';

/** Payload of the unavailable notification. */
export interface UnavailableParams {
  /**
   * "missing": verse.exe does not exist. "unsupported": it does not know the analysis mode.
   * "protocol": it speaks another protocol version.
   */
  reason: UnavailableReason;

  /** The verse.exe that was tried. */
  versePath: string;

  /** The engine checkout it belongs to. */
  engineDir: string;
}

/** Where the engine was found, which decides whether running its verse.exe needs the user's approval. */
export type EngineSource =
  | {
    /** The engineDir setting. */
    kind: 'setting';
  }
  | {
    /** A VersePlayground.local.json file. */
    kind: 'localState';

    /** The local state file that named the engine. */
    stateFilePath: string;
  };

/** Payload of the approveEngine request. */
export interface ApproveEngineParams {
  /** The engine checkout whose verse.exe the server wants to run. */
  engineDir: string;

  /** Where the engine was found. */
  source: EngineSource;

  /** The folder that is about to be analyzed, which the confirmation shows to the user. */
  folder: string;
}

/** Answer to the approveEngine request: true when the server may run the engine's verse.exe for this folder. */
export type ApproveEngineResult = boolean;

/**
 * Request from the client, without parameters: forget which engine every folder uses and what the pings found out,
 * then prepare and analyze every folder again. Restarting the server process has the same effect.
 */
export const RESTART_ANALYSIS_REQUEST = 'versePlayground/restartAnalysis';

/** The initializationOptions that the client sends with the initialize request. */
export interface ServerInitializationOptions {
  /** The versePlayground.engineDir setting as the user wrote it, or an empty string when it is not set. */
  configuredEngineDir: string;

  /** File system paths of the workspace folders, which are searched for an engine after the analyzed folder. */
  workspaceFolders: string[];
}
