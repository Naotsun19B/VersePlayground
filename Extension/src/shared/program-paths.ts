// Copyright (c) 2026 Naotsun

/*
 * Path rules shared by the extension, the language server and the debug adapter.
 *
 * One folder is one Verse program, and every component must agree on which folder a file belongs to, how two spellings
 * of a path are compared, and how a path is spelled when it is handed to verse.exe. The functions here are pure string
 * operations (no file system, no node:path) so that they behave the same on every platform and are easy to test.
 */

/** Extension of Verse source files, in lower case. */
const VERSE_EXTENSION = '.verse';

/** Matches a drive root such as "c:/" or "C:". */
const DRIVE_ROOT_PATTERN = /^[A-Za-z]:\/?$/;

/**
 * Lists the file names in a folder, as spelled on disk. Used to recover the on-disk spelling of a file name.
 * Returns an empty array when the folder cannot be read.
 */
export type FolderLister = (folderPath: string) => readonly string[];

/**
 * Replaces every backslash with a slash and removes trailing slashes,
 * except the one of a root such as "C:/" or "/".
 */
export function normalizePath(filePath: string): string {
  const slashedPath = filePath.replaceAll('\\', '/');
  if (slashedPath === '/' || DRIVE_ROOT_PATTERN.test(slashedPath)) {
    return (slashedPath.endsWith('/') ? slashedPath : `${slashedPath}/`);
  }

  let trimmedPath = slashedPath;
  while (trimmedPath.length > 1 && trimmedPath.endsWith('/')) {
    trimmedPath = trimmedPath.slice(0, -1);
  }
  return trimmedPath;
}

/**
 * Returns the key that two spellings of the same path share: slashes as separators and lower case.
 * Windows paths are case-insensitive, and VS Code may spell the drive letter in either case.
 */
export function toComparisonKey(filePath: string): string {
  return normalizePath(filePath).toLowerCase();
}

/** Returns whether the two paths name the same file or folder, ignoring separators and case. */
export function isSamePath(firstPath: string, secondPath: string): boolean {
  return toComparisonKey(firstPath) === toComparisonKey(secondPath);
}

/** Returns the file name of a path (the part after the last separator). */
export function getFileName(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/');
  return normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1);
}

/** Returns whether the path names a Verse source file, by its extension and ignoring case. */
export function isVerseFile(filePath: string): boolean {
  return getFileName(filePath).toLowerCase().endsWith(VERSE_EXTENSION);
}

/**
 * Returns the folder that holds the file, with "/" separators. This is the program the file belongs to: the folder of
 * the file, without looking at parent folders or subfolders. Returns an empty string for a path without a folder.
 */
export function getProgramFolder(filePath: string): string {
  const normalizedPath = normalizePath(filePath);
  const separatorIndex = normalizedPath.lastIndexOf('/');
  if (separatorIndex < 0) {
    return '';
  }

  if (separatorIndex === 0) {
    return '/';
  }

  if (normalizedPath[separatorIndex - 1] === ':') {
    // "C:/File.verse" lives in the drive root, which keeps its trailing slash.
    return normalizedPath.slice(0, separatorIndex + 1);
  }
  return normalizedPath.slice(0, separatorIndex);
}

/** Returns whether the two files belong to the same program, that is, whether they are in the same folder. */
export function isInSameProgram(firstFilePath: string, secondFilePath: string): boolean {
  return isSamePath(getProgramFolder(firstFilePath), getProgramFolder(secondFilePath));
}

/** Returns whether `childPath` is `parentFolder` or lies anywhere below it. Does not resolve "." or ".." segments. */
export function isInsideFolder(childPath: string, parentFolder: string): boolean {
  const childKey = toComparisonKey(childPath);
  const parentKey = toComparisonKey(parentFolder);
  if (childKey === parentKey) {
    return true;
  }

  const parentPrefix = (parentKey.endsWith('/') ? parentKey : `${parentKey}/`);
  return childKey.startsWith(parentPrefix);
}

/**
 * Returns whether the path is inside the engine checkout. Files there (such as the standard library) are never
 * analyzed as a program of their own. An undefined or empty engine folder contains nothing.
 */
export function isInsideEngine(filePath: string, engineDir: string | undefined): boolean {
  if (engineDir === undefined || engineDir.trim() === '') {
    return false;
  }
  return isInsideFolder(filePath, engineDir);
}

/**
 * Returns the path that the debugger of verse.exe expects for a file the client names.
 *
 * verse.exe compares file names as plain strings, and it names the files of the program like this: the program file
 * is spelled exactly as it was passed on the command line, and every other file of the same folder is the folder part
 * of that spelling (up to and including its last separator) followed by the file name as spelled on disk. The client
 * (VS Code) may spell the drive letter, the separators or the file name differently, so the client's path is mapped
 * to the spelling above. Files outside the folder of the program are returned unchanged.
 *
 * @param clientPath The path VS Code sent.
 * @param programPath The program file exactly as passed to verse.exe, which must be an absolute path.
 * @param listFolder Lists the file names on disk of the folder of the program.
 */
export function toDebuggerPath(clientPath: string, programPath: string, listFolder: FolderLister): string {
  if (isSamePath(clientPath, programPath)) {
    return programPath;
  }

  if (!isInSameProgram(clientPath, programPath)) {
    return clientPath;
  }

  const lastSeparatorIndex = Math.max(programPath.lastIndexOf('\\'), programPath.lastIndexOf('/'));
  const folderPrefix = programPath.slice(0, lastSeparatorIndex + 1);
  const clientFileName = getFileName(clientPath);
  const clientFileNameKey = clientFileName.toLowerCase();
  const diskFileName = listFolder(getProgramFolder(programPath)).find(
    (fileName) => fileName.toLowerCase() === clientFileNameKey,
  );
  return `${folderPrefix}${diskFileName ?? clientFileName}`;
}
