// Copyright (c) 2026 Naotsun

/*
 * The text of the files whose positions have to be converted. verse.exe answers in UTF-8 byte offsets of the text it
 * analyzed; the client wants UTF-16 columns of the text it shows. For a document that is open the text is the one the
 * editor holds, for any other file it is the file on disk.
 */

import { readFileSync } from 'node:fs';

import { splitLines } from './text-positions.ts';

/** Returns the text of the open document at the path, or undefined when no such document is open. */
export type OpenTextLookup = (filePath: string) => string | undefined;

/** Returns the text of the file on disk, or undefined when it cannot be read. */
export type DiskTextReader = (filePath: string) => string | undefined;

/** The UTF-8 byte order mark as Node decodes it: one character at the start of the text. */
const BYTE_ORDER_MARK = '﻿';

/**
 * Reads a file as UTF-8 text without its byte order mark. Returns undefined when it does not exist or cannot be read.
 * The mark is left out because the editor shows the text without it and verse.exe analyzes the text without it, so
 * the columns of the first line would otherwise be one character off.
 */
export function readTextFile(filePath: string): string | undefined {
  try {
    const diskText = readFileSync(filePath, 'utf8');
    return (diskText.startsWith(BYTE_ORDER_MARK) ? diskText.slice(BYTE_ORDER_MARK.length) : diskText);
  } catch {
    return undefined;
  }
}

/**
 * Looks up the text of files while one answer is processed. Every file is read at most once by one instance, so that
 * a long list of diagnostics in the same file costs one read. Create a new instance for each answer, because the text
 * of a file is not expected to stay the same afterwards.
 */
export class DocumentTexts {
  /** Finds the text of an open document. An open document wins over the file on disk. */
  private readonly lookupOpenText: OpenTextLookup;

  /** Reads a file that is not open from disk. */
  private readonly readDiskText: DiskTextReader;

  /** The lines of every file looked at so far, by path. A path that could not be read maps to undefined. */
  private readonly linesByPath = new Map<string, string[] | undefined>();

  /** Creates a lookup. The disk reader can be replaced by tests. */
  public constructor(lookupOpenText: OpenTextLookup, readDiskText: DiskTextReader = readTextFile) {
    this.lookupOpenText = lookupOpenText;
    this.readDiskText = readDiskText;
  }

  /** Returns the lines of the file, or undefined when it is neither open nor readable on disk. */
  public getLines(filePath: string): readonly string[] | undefined {
    if (this.linesByPath.has(filePath)) {
      return this.linesByPath.get(filePath);
    }

    const text = this.lookupOpenText(filePath) ?? this.readDiskText(filePath);
    const lines = (text === undefined ? undefined : splitLines(text));
    this.linesByPath.set(filePath, lines);
    return lines;
  }

  /** Returns the text of one 0-based line, or undefined when the file is unavailable or has no such line. */
  public getLineText(filePath: string, line: number): string | undefined {
    return this.getLines(filePath)?.[line];
  }
}
