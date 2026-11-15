// Copyright (c) 2026 Naotsun

import { isPathInside } from './engine-locator.ts';
import { getProgramFolder, isInsideEngine, isSamePath } from './program-paths.ts';
import type { CheckResult, VersionMap } from './protocol-types.ts';

/** The file that is about to be run. */
export interface FileInfo {
  /** URI scheme of the document. Only "file" documents are analyzed by the language server. */
  scheme: string;

  /** File system path of the document. */
  fsPath: string;

  /** The engine checkout, or undefined when none is known. Files inside it are never analyzed. */
  engineDir: string | undefined;
}

/**
 * Returns whether running this file needs no problem matcher, because the language server already reports the
 * problems of its folder.
 *
 * It is true only when the file is a "file" document outside the engine, the latest analysis of its folder succeeded,
 * and that analysis saw exactly the documents that are open now at the same versions. The last condition covers an
 * edit that is run before the server was told about it.
 *
 * @param file The file about to be run.
 * @param latest The most recent checkResult of the file's folder, or undefined when there is none.
 * @param currentVersions The versions of the documents of the file's folder that are open now, by URI string.
 */
export function isCoveredByLanguageServer(
  file: Readonly<FileInfo>,
  latest: Readonly<CheckResult> | undefined,
  currentVersions: VersionMap,
): boolean {
  if (file.scheme !== 'file' || isInsideEngine(file.fsPath, file.engineDir)) {
    return false;
  }

  if (latest === undefined || latest.state !== 'ok' || latest.versions === undefined) {
    return false;
  }

  if (!isSamePath(latest.folder, getProgramFolder(file.fsPath))) {
    return false;
  }

  return areSameVersions(latest.versions, currentVersions);
}

/**
 * Returns whether the UEFN language server reports the problems of a file, so that running it needs no problem matcher.
 *
 * It is true only while the server runs, for a file inside the workspace and outside the engine checkout. The engine
 * checkout is often inside the workspace, so being in the workspace alone does not make a file the user's code.
 *
 * @param isServerRunning Whether the language client is running.
 * @param isInsideWorkspace Whether the file is inside one of the open workspace folders.
 * @param fsPath File system path of the file.
 * @param engineDir The engine checkout.
 */
export function isUefnReportingProblems(
  isServerRunning: boolean,
  isInsideWorkspace: boolean,
  fsPath: string,
  engineDir: string,
): boolean {
  return (isServerRunning && isInsideWorkspace && !isPathInside(fsPath, engineDir));
}

/** Returns whether both maps hold the same documents at the same versions. */
function areSameVersions(analyzedVersions: VersionMap, currentVersions: VersionMap): boolean {
  const analyzedUris = Object.keys(analyzedVersions);
  if (analyzedUris.length !== Object.keys(currentVersions).length) {
    return false;
  }
  return analyzedUris.every(
    (uri) => Object.hasOwn(currentVersions, uri) && currentVersions[uri] === analyzedVersions[uri],
  );
}
