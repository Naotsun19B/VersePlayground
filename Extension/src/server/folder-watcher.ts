// Copyright (c) 2026 Naotsun

/*
 * Watches the folders of programs that lie outside the workspace, where the client's file events do not reach.
 *
 * Each folder gets one non-recursive `fs.watch`. A watcher can fail at any time (the folder is deleted, access is
 * lost), and an unhandled 'error' event would take the whole server down, so every watcher has an error handler that
 * closes it, forgets the folder and reports it. The number of watchers is limited.
 */

import * as fs from 'node:fs';

import { isVerseFile, normalizePath, toComparisonKey } from '../shared/program-paths.ts';

/** Largest number of folders watched at the same time. */
export const MAX_WATCHED_FOLDERS = 32;

/** The part of `fs.watch` that is used, so that tests can replace it. */
export type WatchFunction = (
  folder: string,
  listener: (eventType: string, fileName: string | null) => void,
) => fs.FSWatcher;

/** Callbacks of the watcher. */
export interface FolderWatcherHandlers {
  /** A .verse file of the folder was created, changed, renamed or deleted. */
  onChange(folder: string): void;

  /** The watcher of the folder failed after it was started. It is already closed and the folder forgotten. */
  onError(folder: string, watcherError: Error): void;
}

/** The result of asking to watch a folder. */
export type WatchResult =
  | {
    /** The folder is watched, newly or already. */
    status: 'watching';
  }
  | {
    /** The limit of watched folders is reached, so the folder was not watched. */
    status: 'limit';
  }
  | {
    /** The watcher could not be created. */
    status: 'failed';

    /** Why. */
    watcherError: Error;
  };

/** A folder that is watched, with the watcher that watches it. */
interface WatchedFolder {
  // The folder with "/" separators.
  folder: string;

  // The watcher of the folder.
  watcher: fs.FSWatcher;
}

/** Watches a set of folders. */
export class FolderWatcher {
  /** Watchers by the comparison key of the folder, in the order they were added. */
  private readonly watchers = new Map<string, WatchedFolder>();

  /** Receives the changes and the errors. */
  private readonly handlers: FolderWatcherHandlers;

  /** Creates the watchers. */
  private readonly watchFunction: WatchFunction;

  /** The most folders that are watched at once. */
  private readonly maxFolders: number;

  /**
   * Creates a watcher that watches no folder yet.
   *
   * @param handlers Receives the changes and the errors.
   * @param maxFolders The most folders that are watched at once.
   * @param watchFunction Creates the watchers. Tests replace it.
   */
  public constructor(
    handlers: FolderWatcherHandlers,
    maxFolders: number = MAX_WATCHED_FOLDERS,
    watchFunction: WatchFunction = (folder, listener) => fs.watch(folder, { persistent: false }, listener),
  ) {
    this.handlers = handlers;
    this.maxFolders = maxFolders;
    this.watchFunction = watchFunction;
  }

  /** Starts watching a folder. Does nothing if it is already watched. Never throws. */
  public watch(folder: string): WatchResult {
    const folderKey = toComparisonKey(folder);
    if (this.watchers.has(folderKey)) {
      return { status: 'watching' };
    }

    if (this.watchers.size >= this.maxFolders) {
      return { status: 'limit' };
    }

    const normalizedFolder = normalizePath(folder);
    let watcher: fs.FSWatcher;
    try {
      watcher = this.watchFunction(normalizedFolder, (_eventType, fileName) => {
        // A missing file name means the platform could not say which file changed, so assume it was a .verse file.
        if (fileName === null || isVerseFile(fileName)) {
          this.handlers.onChange(normalizedFolder);
        }
      });
    } catch (error) {
      return { status: 'failed', watcherError: (error instanceof Error ? error : new Error(String(error))) };
    }

    watcher.on('error', (watcherError: Error) => {
      this.unwatch(normalizedFolder);
      this.handlers.onError(normalizedFolder, watcherError);
    });
    this.watchers.set(folderKey, { folder: normalizedFolder, watcher });
    return { status: 'watching' };
  }

  /** Stops watching a folder. Does nothing if it is not watched. */
  public unwatch(folder: string): void {
    const folderKey = toComparisonKey(folder);
    const entry = this.watchers.get(folderKey);
    if (entry === undefined) {
      return;
    }

    this.watchers.delete(folderKey);
    try {
      entry.watcher.close();
    } catch {
      // The watcher is already unusable; there is nothing left to release.
    }
  }

  /** Stops watching every folder. */
  public unwatchAll(): void {
    for (const entry of [...this.watchers.values()]) {
      this.unwatch(entry.folder);
    }
  }

  /** Returns whether the folder is watched. */
  public isWatching(folder: string): boolean {
    return this.watchers.has(toComparisonKey(folder));
  }

  /** Returns the watched folders, the one that was added first at the front. */
  public getWatchedFolders(): string[] {
    return [...this.watchers.values()].map((entry) => entry.folder);
  }

  /** Returns whether one more folder can be watched. */
  public hasRoom(): boolean {
    return this.watchers.size < this.maxFolders;
  }
}
