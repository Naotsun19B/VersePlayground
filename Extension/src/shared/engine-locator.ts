// Copyright (c) 2026 Naotsun

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EngineSource } from './protocol-types.ts';

/** Name of the file that Setup.bat writes next to itself to record where the engine checkout is. */
export const LOCAL_STATE_FILE_NAME = 'VersePlayground.local.json';

/** Files of an engine checkout that the extension uses. */
export interface EngineLocation {
  /** Root of the engine checkout, the folder that contains Engine/. */
  engineDir: string;

  /** verse.exe, the Verse command-line tool that runs and debugs a single Verse file. */
  versePath: string;

  /**
   * Verse project that UnrealBuildTool writes while building verse.exe. It lists the packages of the Verse
   * standard library and of verse.exe's input/output functions, which the language server needs.
   */
  vniProjectPath: string;

  /** Folder of the Verse TextMate grammar that the engine ships for its Visual Studio extension. */
  grammarDir: string;

  /** The language configuration (comments, brackets) that goes with the grammar. */
  languageConfigurationPath: string;
}

/** How an engine checkout was found. Defined in protocol-types.ts, which the approveEngine request also uses. */
export type { EngineSource };

/** An engine checkout together with the way it was found, which decides whether it can be used without asking. */
export interface EngineResolution {
  /** The files of the engine checkout. */
  location: EngineLocation;

  /** Where the engine folder came from. */
  source: EngineSource;
}

/**
 * Resolves the engine checkout to use.
 *
 * A non-empty `configuredEngineDir` wins. Otherwise each start folder and its parents are searched for the local state
 * file that Setup.bat writes, so opening the repository root or any folder below it works.
 *
 * @returns The engine location and how it was found, or undefined when no engine was found.
 */
export function findEngine(
  configuredEngineDir: string,
  startFolders: readonly string[],
): EngineResolution | undefined {
  if (configuredEngineDir.trim() !== '') {
    return {
      location: toEngineLocation(configuredEngineDir.trim()),
      source: { kind: 'setting' },
    };
  }

  for (const startFolder of startFolders) {
    const localState = readEngineDirFromLocalState(startFolder);
    if (localState !== undefined) {
      return {
        location: toEngineLocation(localState.engineDir),
        source: { kind: 'localState', stateFilePath: localState.stateFilePath },
      };
    }
  }
  return undefined;
}

/** Builds the paths of the files the extension uses from the engine root. */
export function toEngineLocation(engineDir: string): EngineLocation {
  const grammarDir = path.join(engineDir, 'Engine', 'Source', 'Programs', 'UnrealVS', 'UnrealVS', 'Grammars');
  return {
    engineDir,
    versePath: path.join(engineDir, 'Engine', 'Binaries', 'Win64', 'verse.exe'),
    vniProjectPath: path.join(engineDir, 'Engine', 'Intermediate', 'Build', 'Win64', 'verse', 'VNI.vproject'),
    grammarDir,
    languageConfigurationPath: path.join(path.dirname(grammarDir), 'verse-language-configuration.json'),
  };
}

/** Returns true when `childPath` is `parentPath` or inside it. Windows paths are compared without case. */
export function isPathInside(childPath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath.toLowerCase(), childPath.toLowerCase());
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

/**
 * Walks from `startFolder` up to the drive root and returns `engineDir` and the file it came from, taken from the first
 * local state file found. A file that cannot be read or parsed is skipped, so a broken file in one folder does not
 * hide one further up.
 */
function readEngineDirFromLocalState(startFolder: string): { engineDir: string; stateFilePath: string } | undefined {
  let currentFolder = path.resolve(startFolder);
  for (;;) {
    const stateFilePath = path.join(currentFolder, LOCAL_STATE_FILE_NAME);
    const stateEngineDir = tryReadEngineDir(stateFilePath);
    if (stateEngineDir !== undefined) {
      return { engineDir: stateEngineDir, stateFilePath };
    }

    const parentFolder = path.dirname(currentFolder);
    if (parentFolder === currentFolder) {
      return undefined;
    }
    currentFolder = parentFolder;
  }
}

/** Reads `engineDir` from one local state file, or returns undefined when the file is missing or malformed. */
function tryReadEngineDir(stateFilePath: string): string | undefined {
  let stateText: string;
  try {
    stateText = fs.readFileSync(stateFilePath, 'utf8');
  } catch {
    return undefined;
  }

  try {
    const localState: unknown = JSON.parse(stateText);
    if (
      typeof localState === 'object' &&
      localState !== null &&
      'engineDir' in localState &&
      typeof localState.engineDir === 'string' &&
      localState.engineDir !== ''
    ) {
      return localState.engineDir;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
