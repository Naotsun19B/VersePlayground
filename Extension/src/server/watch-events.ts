// Copyright (c) 2026 Naotsun

import { fileURLToPath } from 'node:url';
import { FileChangeType, type FileEvent } from 'vscode-languageserver/node';

import { LOCAL_STATE_FILE_NAME } from '../shared/engine-locator.ts';
import { getFileName, getProgramFolder, isVerseFile, toComparisonKey } from '../shared/program-paths.ts';

/** The name of the local state file in lower case, for comparing file names without case. */
const LOCAL_STATE_FILE_KEY = LOCAL_STATE_FILE_NAME.toLowerCase();

/** What a batch of file events asks the server to do. */
export interface WatchedFilesPlan {
  /** Whether a local state file was created, changed or deleted, which makes every folder look for its engine again. */
  isLocalStateChanged: boolean;

  /** The program folders with "/" separators whose .verse files changed on disk, each once. */
  changedFolders: string[];
}

/** Returns the file system path of a file URI, or undefined for any other URI. */
export function toFilePath(uri: string): string | undefined {
  if (!uri.toLowerCase().startsWith('file:')) {
    return undefined;
  }

  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/**
 * Decides what the file events of the client's watcher lead to. Events of other URI schemes are skipped. A local state
 * file counts wherever it is. A .verse file leads to its folder, except that saving a document that is open changes
 * the file but not what is analyzed, because the analysis already uses the editor's text.
 *
 * @param changes The file events.
 * @param isOpenDocument Returns whether the editor has the file open.
 */
export function planWatchedFileChanges(
  changes: readonly FileEvent[],
  isOpenDocument: (filePath: string) => boolean,
): WatchedFilesPlan {
  let isLocalStateChanged = false;
  const changedFolders = new Map<string, string>();
  for (const change of changes) {
    const filePath = toFilePath(change.uri);
    if (filePath === undefined) {
      continue;
    }

    if (getFileName(filePath).toLowerCase() === LOCAL_STATE_FILE_KEY) {
      isLocalStateChanged = true;
      continue;
    }

    const isSavedDocument = (change.type === FileChangeType.Changed && isOpenDocument(filePath));
    if (isVerseFile(filePath) && !isSavedDocument) {
      const folder = getProgramFolder(filePath);
      changedFolders.set(toComparisonKey(folder), folder);
    }
  }

  return { isLocalStateChanged, changedFolders: [...changedFolders.values()] };
}
