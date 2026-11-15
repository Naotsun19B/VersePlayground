// Copyright (c) 2026 Naotsun

/*
 * Conversion between the two column units in play: LSP columns count UTF-16 code units, while verse.exe counts UTF-8
 * bytes within the line. Both are 0-based. The functions take the text of one line, which is what the callers have,
 * and never look at other lines.
 */

/** Splits text into lines at CRLF, LF or CR, like LSP does. The terminators are not part of the lines. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

/** Returns the line without a trailing line terminator, in case the caller kept one. */
function stripLineTerminator(lineText: string): string {
  const terminatorIndex = lineText.search(/[\r\n]/);
  return (terminatorIndex < 0 ? lineText : lineText.slice(0, terminatorIndex));
}

/** Returns the number of UTF-8 bytes the code point takes. A lone surrogate counts as the 3 bytes of U+FFFD. */
function getUtf8Length(codePoint: number, isLoneSurrogate: boolean): number {
  if (isLoneSurrogate) {
    return 3;
  }

  if (codePoint < 0x80) {
    return 1;
  }

  if (codePoint < 0x800) {
    return 2;
  }

  if (codePoint < 0x10000) {
    return 3;
  }
  return 4;
}

/** Returns whether the UTF-16 code unit at the index is a surrogate that has no partner. */
function isLoneSurrogateAt(lineText: string, index: number): boolean {
  const codeUnit = lineText.charCodeAt(index);
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
    const nextCodeUnit = lineText.charCodeAt(index + 1);
    return !(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff);
  }
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Converts a UTF-16 column to the UTF-8 byte offset in the same line.
 * A column past the end of the line (or a line terminator) is clamped to the end of the line, and a column in the
 * middle of a surrogate pair is treated as the start of that pair.
 */
export function toUtf8ByteColumn(lineText: string, utf16Column: number): number {
  const visibleText = stripLineTerminator(lineText);
  const limit = Math.min(Math.max(utf16Column, 0), visibleText.length);

  let byteColumn = 0;
  let index = 0;
  while (index < limit) {
    const isLoneSurrogate = isLoneSurrogateAt(visibleText, index);
    const codePoint = visibleText.codePointAt(index) ?? 0;
    const unitCount = (codePoint > 0xffff ? 2 : 1);
    if (index + unitCount > limit) {
      break;
    }
    byteColumn += getUtf8Length(codePoint, isLoneSurrogate);
    index += unitCount;
  }
  return byteColumn;
}

/**
 * Converts a UTF-8 byte offset in a line to the UTF-16 column.
 * An offset past the end of the line (or a line terminator) is clamped to the end of the line, and an offset in the
 * middle of a character is treated as the start of that character.
 */
export function toUtf16Column(lineText: string, byteColumn: number): number {
  const visibleText = stripLineTerminator(lineText);
  const limit = Math.max(byteColumn, 0);

  let consumedBytes = 0;
  let index = 0;
  while (index < visibleText.length) {
    const isLoneSurrogate = isLoneSurrogateAt(visibleText, index);
    const codePoint = visibleText.codePointAt(index) ?? 0;
    const byteLength = getUtf8Length(codePoint, isLoneSurrogate);
    if (consumedBytes + byteLength > limit) {
      break;
    }
    consumedBytes += byteLength;
    index += (codePoint > 0xffff ? 2 : 1);
  }
  return index;
}
