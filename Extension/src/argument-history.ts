// Copyright (c) 2026 Naotsun

/** Number of argument lines kept for each Verse file. Older lines drop off the end. */
export const MAX_ARGUMENT_LINES_PER_FILE = 20;

/**
 * Argument lines used before, for each Verse file, newest first.
 * The key is the file path in lower case, because Windows paths name the same file in any case.
 */
export type ArgumentHistory = Readonly<Record<string, readonly string[]>>;

/** Returns the argument lines used with the file, newest first. */
export function getArgumentLines(history: ArgumentHistory, filePath: string): readonly string[] {
  return history[toHistoryKey(filePath)] ?? [];
}

/**
 * Returns a copy of the history with the argument line at the front of the file's list.
 *
 * A line used before moves to the front instead of appearing twice. A blank line is not recorded, since running
 * without arguments needs no history.
 */
export function recordArgumentLine(history: ArgumentHistory, filePath: string, argumentLine: string): ArgumentHistory {
  if (argumentLine.trim().length === 0) {
    return history;
  }

  const previousLines = getArgumentLines(history, filePath).filter((previousLine) => previousLine !== argumentLine);
  return {
    ...history,
    [toHistoryKey(filePath)]: [argumentLine, ...previousLines].slice(0, MAX_ARGUMENT_LINES_PER_FILE),
  };
}

/** Returns the key that the history of a file is stored under. */
function toHistoryKey(filePath: string): string {
  return filePath.toLowerCase();
}
