// Copyright (c) 2026 Naotsun

import * as path from 'node:path';

import { isInSameProgram, isVerseFile } from './shared/program-paths.ts';

/** The parts of a text document that decide whether it must be saved before the program runs. */
export interface ProgramDocument {
  /** Where the document lives. Only documents on the file system can be read by verse.exe. */
  uri: { fsPath: string; scheme: string };

  /** Whether the document has changes that are not on disk yet. */
  isDirty: boolean;
}

/**
 * Returns the documents that verse.exe would read stale from disk: the unsaved Verse files of the folder that holds
 * the program. verse.exe compiles every .verse file directly in that folder, so a sibling counts as much as the
 * program.
 */
export function selectUnsavedProgramDocuments<TDocument extends Readonly<ProgramDocument>>(
  documents: readonly TDocument[],
  programPath: string,
): TDocument[] {
  return documents.filter((document) => (
    document.isDirty &&
    document.uri.scheme === 'file' &&
    isVerseFile(document.uri.fsPath) &&
    isInSameProgram(document.uri.fsPath, programPath)
  ));
}

/**
 * Saves the documents one after another and stops at the first one that cannot be saved.
 * Returns whether every document was saved, so the caller does not run a program built from stale files.
 */
export async function saveAllDocuments<TDocument>(
  documents: readonly TDocument[],
  save: (document: TDocument) => PromiseLike<boolean>,
): Promise<boolean> {
  for (const document of documents) {
    if (!(await save(document))) {
      return false;
    }
  }
  return true;
}

/**
 * Turns the `program` of a launch configuration (after variables were substituted) into an absolute path.
 * A relative path is resolved against `baseFolder`. Returns undefined when the path is relative and there is no folder
 * to resolve it against, or when `program` is not a non-empty string.
 */
export function resolveProgramPath(program: unknown, baseFolder: string | undefined): string | undefined {
  if (typeof program !== 'string' || program.trim() === '') {
    return undefined;
  }

  if (path.isAbsolute(program)) {
    return program;
  }

  if (baseFolder === undefined) {
    return undefined;
  }
  return path.resolve(baseFolder, program);
}
