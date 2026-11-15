// Copyright (c) 2026 Naotsun

import type * as vscode from 'vscode';

/** Kind of language server the extension can run. */
export type LanguageServerKind = 'builtin' | 'uefn';

/** A running (or startable) language server client, whichever kind it is. */
export interface LanguageServerHandle extends vscode.Disposable {
  /** Starts the server. Restarts it when it is already running. */
  start(): Promise<void>;

  /** Stops the server. Safe to call when it is not running. */
  stop(): Promise<void>;

  /** Whether the server reports the problems of this file, so running it needs no problem matcher. */
  isReportingProblemsFor(uri: vscode.Uri): boolean;
}

/** Facts that decide whether and which language server to start. */
export interface LanguageServerDecisionInput {
  /** The languageServer.enabled setting. */
  isEnabled: boolean;

  /** Whether the workspace is trusted. */
  isTrusted: boolean;

  /** Whether the UEFN Verse extension is enabled, which would report every problem a second time. */
  isUefnExtensionEnabled: boolean;

  /** The languageServer.kind setting. */
  kind: LanguageServerKind;

  /** Whether an engine checkout was found. Only the "uefn" kind needs it at startup. */
  isEngineFound: boolean;
}

/** Why no language server is started. */
export type LanguageServerSkipReason = 'disabled' | 'untrusted' | 'uefnExtensionEnabled' | 'engineNotFound';

/** Outcome of the decision: start a kind of server, or do not start and say why. */
export type LanguageServerDecision =
  | {
    /** Start a server. */
    action: 'start';

    /** The kind to start. */
    kind: LanguageServerKind;
  }
  | {
    /** Do not start a server. */
    action: 'skip';

    /** Why not. */
    reason: LanguageServerSkipReason;
  };

/**
 * Decides whether to start a language server and which kind, in this order: disabled, untrusted workspace, UEFN Verse
 * extension enabled (both kinds would duplicate its diagnostics), then the kind. The "uefn" kind needs an engine
 * checkout; the "builtin" kind does not, because it resolves the engine for each folder itself.
 */
export function decideLanguageServer(input: Readonly<LanguageServerDecisionInput>): LanguageServerDecision {
  if (!input.isEnabled) {
    return { action: 'skip', reason: 'disabled' };
  }

  if (!input.isTrusted) {
    return { action: 'skip', reason: 'untrusted' };
  }

  if (input.isUefnExtensionEnabled) {
    return { action: 'skip', reason: 'uefnExtensionEnabled' };
  }

  if (input.kind === 'uefn') {
    if (!input.isEngineFound) {
      return { action: 'skip', reason: 'engineNotFound' };
    }
    return { action: 'start', kind: 'uefn' };
  }
  return { action: 'start', kind: 'builtin' };
}
