// Copyright (c) 2026 Naotsun

/*
 * The protocol between the language server and `verse.exe --ide-request`: building the request that goes to stdin and
 * validating the answer line from stdout. Everything here is a pure function; spawning the process is the runner's job.
 */

import { normalizePath } from '../shared/program-paths.ts';

/** Version of the protocol that this build speaks. */
export const PROTOCOL_VERSION = 1;

/** Every answer of verse.exe is one stdout line that starts with this prefix. */
export const RESPONSE_PREFIX = '@verse-ide ';

/** Largest request, in bytes, that is sent. verse.exe refuses to read more. */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** A position in a file: a 0-based line and a 0-based UTF-8 byte offset within that line. */
export interface IdePosition {
  /** 0-based line. */
  line: number;

  /** 0-based offset in UTF-8 bytes from the start of the line. */
  byte: number;
}

/** A range of a file. The end is not included. */
export interface IdeRange {
  /** First position of the range. */
  start: IdePosition;

  /** Position just after the range. */
  end: IdePosition;
}

/** The text of an open document, which is analyzed instead of the file on disk. */
export interface IdeOverride {
  /** Absolute path of the document, directly inside the folder of the request. */
  path: string;

  /** Full text of the document. */
  text: string;
}

/** What a request asks for. */
export type IdeRequestKind = 'ping' | 'check' | 'hover' | 'definition';

/** One request to verse.exe. */
export interface IdeRequest {
  /** Protocol version. */
  protocol: number;

  /** What to do. */
  kind: IdeRequestKind;

  /** The folder to analyze as one program. Absent for ping. */
  folder?: string;

  /** The file under the cursor. Present for hover and definition. */
  target?: string;

  /** The position under the cursor. Present for hover and definition. */
  position?: IdePosition;

  /** Open documents of the folder. Absent for ping. */
  overrides?: IdeOverride[];
}

/** Severity of a diagnostic as verse.exe names it. */
export type IdeSeverity = 'error' | 'warning' | 'info';

/** One diagnostic of the answer. */
export interface IdeDiagnostic {
  /** Absolute path with "/" separators, or an empty string for a diagnostic of the whole project. */
  path: string;

  /** Verse diagnostic code. */
  code: number;

  /** Severity. */
  severity: IdeSeverity;

  /** Message, which may span several lines. */
  message: string;

  /** Where the diagnostic points. */
  range: IdeRange;
}

/** The answer to a hover request. */
export interface IdeHover {
  /** Signature or type of the definition. */
  text: string;

  /** The identifier the cursor is on. */
  range: IdeRange;
}

/** The answer to a definition request. */
export interface IdeDefinition {
  /** Absolute path of the file that holds the definition. */
  path: string;

  /** The definition's range in that file. */
  range: IdeRange;
}

/** A successful answer. */
export interface IdeSuccess {
  /** Protocol version of the answer. */
  protocol: number;

  /** Diagnostics of the whole program. Empty for ping. */
  diagnostics: IdeDiagnostic[];

  /** The hover result, or null when there is none (or the request was not a hover). */
  hover: IdeHover | null;

  /** The definition result, or null when there is none (or the request was not a definition). */
  definition: IdeDefinition | null;
}

/** The outcome of reading one answer line. */
export type IdeParseResult =
  | {
    /** verse.exe answered and the request was served. */
    status: 'ok';

    /** The answer. */
    response: IdeSuccess;
  }
  | {
    /** verse.exe answered that it refused the request (`ok: false`). */
    status: 'rejected';

    /** The reason verse.exe gave. */
    error: string;
  }
  | {
    /** verse.exe speaks another protocol version. */
    status: 'protocolMismatch';

    /** The version it reported. */
    protocol: unknown;
  }
  | {
    /** The line is not a well-formed answer. */
    status: 'invalid';

    /** What is wrong with it. */
    error: string;
  };

/** The outcome of turning a request into bytes. */
export type EncodeResult =
  | {
    /** The request fits. */
    isOk: true;

    /** UTF-8 bytes (no BOM) to write to stdin. */
    body: Buffer;
  }
  | {
    /** The request is over the size limit. */
    isOk: false;

    /** What is wrong with it. */
    error: string;
  };

/** Builds a ping request, which only asks whether verse.exe knows the analysis mode. */
export function buildPingRequest(): IdeRequest {
  return { protocol: PROTOCOL_VERSION, kind: 'ping' };
}

/** Builds a request for the diagnostics of the program in a folder. */
export function buildCheckRequest(folder: string, overrides: readonly IdeOverride[]): IdeRequest {
  return {
    protocol: PROTOCOL_VERSION,
    kind: 'check',
    folder: normalizePath(folder),
    overrides: normalizeOverrides(overrides),
  };
}

/** Builds a hover or definition request for a position in a file of the folder. */
export function buildLookupRequest(
  kind: 'hover' | 'definition',
  folder: string,
  target: string,
  position: Readonly<IdePosition>,
  overrides: readonly IdeOverride[],
): IdeRequest {
  return {
    protocol: PROTOCOL_VERSION,
    kind,
    folder: normalizePath(folder),
    target: normalizePath(target),
    position: { line: position.line, byte: position.byte },
    overrides: normalizeOverrides(overrides),
  };
}

/** Gives every override path "/" separators, which is the spelling verse.exe matches against. */
function normalizeOverrides(overrides: readonly IdeOverride[]): IdeOverride[] {
  return overrides.map((override) => ({ path: normalizePath(override.path), text: override.text }));
}

/** Serializes a request as UTF-8 without a BOM, or reports that it is over the size limit. */
export function encodeRequest(request: Readonly<IdeRequest>): EncodeResult {
  const body = Buffer.from(JSON.stringify(request), 'utf8');
  if (body.length > MAX_REQUEST_BYTES) {
    return {
      isOk: false,
      error: `The request is ${body.length} bytes, which is over the limit of ${MAX_REQUEST_BYTES} bytes.`,
    };
  }
  return { isOk: true, body };
}

/**
 * Finds the answer in the text that verse.exe wrote to stdout and returns the JSON that follows the prefix.
 *
 * Other output may come before or after it, so lines are examined one by one. Only a line that starts with the
 * prefix counts: verse.exe starts its answer on a fresh line, and a prefix in the middle of a line is part of some
 * other output. The first such line wins. Returns undefined when there is none.
 */
export function extractResponseLine(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(RESPONSE_PREFIX)) {
      return line.slice(RESPONSE_PREFIX.length);
    }
  }
  return undefined;
}

/** Parses and validates the JSON of an answer. Never throws. */
export function parseResponse(responseJson: string): IdeParseResult {
  let value: unknown;
  try {
    value = JSON.parse(responseJson);
  } catch (error) {
    return { status: 'invalid', error: `The answer is not valid JSON: ${String(error)}` };
  }
  if (!isRecord(value)) {
    return { status: 'invalid', error: 'The answer is not a JSON object.' };
  }

  if (value.protocol !== PROTOCOL_VERSION) {
    return { status: 'protocolMismatch', protocol: value.protocol };
  }

  if (value.ok === false) {
    return { status: 'rejected', error: (typeof value.error === 'string' ? value.error : 'No reason was given.') };
  }

  if (value.ok !== true) {
    return { status: 'invalid', error: 'The answer has no "ok" flag.' };
  }

  const diagnostics = parseDiagnostics(value.diagnostics);
  if (diagnostics === undefined) {
    return { status: 'invalid', error: 'The "diagnostics" of the answer are malformed.' };
  }

  const hover = parseHover(value.hover);
  if (hover === undefined) {
    return { status: 'invalid', error: 'The "hover" of the answer is malformed.' };
  }

  const definition = parseDefinition(value.definition);
  if (definition === undefined) {
    return { status: 'invalid', error: 'The "definition" of the answer is malformed.' };
  }
  return { status: 'ok', response: { protocol: PROTOCOL_VERSION, diagnostics, hover, definition } };
}

/** Extracts the answer from the whole stdout text and validates it. */
export function parseOutput(output: string): IdeParseResult {
  const responseJson = extractResponseLine(output);
  if (responseJson === undefined) {
    return { status: 'invalid', error: 'The output has no answer line.' };
  }
  return parseResponse(responseJson);
}

/** Returns whether the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null && !Array.isArray(value));
}

/** Returns whether the value is a non-negative integer. */
function isCount(value: unknown): value is number {
  return (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

/** Reads a position, or returns undefined when it is malformed. */
function parsePosition(value: unknown): IdePosition | undefined {
  if (!isRecord(value) || !isCount(value.line) || !isCount(value.byte)) {
    return undefined;
  }
  return { line: value.line, byte: value.byte };
}

/** Reads a range, or returns undefined when it is malformed. */
function parseRange(value: unknown): IdeRange | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const start = parsePosition(value.start);
  const end = parsePosition(value.end);
  return (start === undefined || end === undefined ? undefined : { start, end });
}

/** Reads the diagnostics. An absent list is empty. Returns undefined when any entry is malformed. */
function parseDiagnostics(value: unknown): IdeDiagnostic[] | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const diagnostics: IdeDiagnostic[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) {
      return undefined;
    }

    const range = parseRange(entry.range);
    const severity = entry.severity;
    if (
      typeof entry.path !== 'string' ||
      typeof entry.code !== 'number' ||
      (severity !== 'error' && severity !== 'warning' && severity !== 'info') ||
      typeof entry.message !== 'string' ||
      range === undefined
    ) {
      return undefined;
    }
    diagnostics.push({ path: entry.path, code: entry.code, severity, message: entry.message, range });
  }
  return diagnostics;
}

/** Reads a hover result. Absent and null both mean "none". Returns undefined when it is malformed. */
function parseHover(value: unknown): IdeHover | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const range = parseRange(value.range);
  return (typeof value.text !== 'string' || range === undefined ? undefined : { text: value.text, range });
}

/** Reads a definition result. Absent and null both mean "none". Returns undefined when it is malformed. */
function parseDefinition(value: unknown): IdeDefinition | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const range = parseRange(value.range);
  return (typeof value.path !== 'string' || range === undefined ? undefined : { path: value.path, range });
}
