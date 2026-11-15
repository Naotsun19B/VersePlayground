// Copyright (c) 2026 Naotsun

/*
 * Turns the diagnostics of one answer into the list of publishDiagnostics notifications to send. This is a pure
 * function: the text of files and the conversion of a path to a URI are passed in, so that it can be tested without
 * a language server and without the vscode-uri package.
 */

import type { Diagnostic } from 'vscode-languageserver';

import { getFileName, getProgramFolder, isSamePath, toComparisonKey } from '../shared/program-paths.ts';
import type { IdeDiagnostic } from './ide-protocol.ts';
import { toUtf16Column } from './text-positions.ts';

/** LSP severity numbers, by the severity names of verse.exe. */
const LSP_SEVERITIES = { error: 1, warning: 2, info: 3 } as const;

/** An open document of the folder. */
export interface OpenDocumentInfo {
  /** Absolute path of the document. */
  path: string;

  /** The URI string that the client uses for the document, which is what must be published to. */
  uri: string;
}

/** What the plan is computed from. */
export interface PublishPlanInput {
  /** The analyzed folder. Only files directly in it get diagnostics. */
  folder: string;

  /** Diagnostics of the answer. */
  diagnostics: readonly IdeDiagnostic[];

  /** Open documents. Documents outside the folder are ignored. */
  openDocuments: readonly OpenDocumentInfo[];

  /** What was published for this folder last time: comparison key of the path to the URI string that was used. */
  previous: ReadonlyMap<string, string>;

  /** Returns the text of one 0-based line of a file, or undefined when the file or the line is unavailable. */
  getLineText: (filePath: string, line: number) => string | undefined;

  /** Turns an absolute path into the URI string of a file that is not open. */
  toUri: (filePath: string) => string;

  /** Returns the path of the first .verse file of the folder on disk, in name order, or undefined if there is none. */
  findFirstFileOnDisk: () => string | undefined;
}

/** One publishDiagnostics notification to send. An empty list clears the diagnostics of the URI. */
export interface PublishItem {
  /** URI string to publish to. */
  uri: string;

  /** Diagnostics to show. */
  diagnostics: Diagnostic[];
}

/** The result of planning. */
export interface PublishPlan {
  /** Notifications to send in this order: the clearing ones come first. */
  items: PublishItem[];

  /** What is published now, to be passed as `previous` next time. Only URIs that hold diagnostics are listed. */
  published: Map<string, string>;

  /** Things that are not published or that are approximated, for the output channel. */
  logs: string[];
}

/** Returns the plan that clears everything that was published, which is what a failed check needs. */
export function planClear(previous: ReadonlyMap<string, string>): PublishPlan {
  return {
    items: [...previous.values()].map((uri) => ({ uri, diagnostics: [] })),
    published: new Map(),
    logs: [],
  };
}

/** The diagnostics that belong to one file. */
interface DiagnosticGroup {
  // The path the diagnostics are published for.
  path: string;

  // The diagnostics in the order verse.exe reported them.
  diagnostics: Diagnostic[];
}

/** Plans the notifications for the diagnostics of one successful answer. */
export function planPublish(input: Readonly<PublishPlanInput>): PublishPlan {
  const logs: string[] = [];
  const folderDocuments = input.openDocuments
    .filter((document) => isSamePath(getProgramFolder(document.path), input.folder))
    .sort((first, second) => compareFileNames(first.path, second.path));
  const uriByKey = new Map(folderDocuments.map((document) => [toComparisonKey(document.path), document.uri]));

  // Diagnostics by comparison key. A Map keeps the order in which the files first appear.
  const groups = new Map<string, DiagnosticGroup>();
  const unreadablePaths = new Set<string>();
  for (const diagnostic of input.diagnostics) {
    const targetPath = resolveTargetPath(diagnostic, input, folderDocuments, logs);
    if (targetPath === undefined) {
      continue;
    }

    const key = toComparisonKey(targetPath);
    const group = groups.get(key) ?? { path: targetPath, diagnostics: [] };
    groups.set(key, group);
    group.diagnostics.push(toLspDiagnostic(diagnostic, targetPath, input, unreadablePaths, logs));
  }

  const published = new Map<string, string>();
  const publishItems: PublishItem[] = [];
  for (const [key, group] of groups) {
    const uri = uriByKey.get(key) ?? input.toUri(group.path);
    published.set(key, uri);
    publishItems.push({ uri, diagnostics: group.diagnostics });
  }

  // A URI that held diagnostics and does not any more, or that is now spelled differently, must be cleared.
  const clearItems: PublishItem[] = [];
  for (const [key, oldUri] of input.previous) {
    if (published.get(key) !== oldUri) {
      clearItems.push({ uri: oldUri, diagnostics: [] });
    }
  }
  return { items: [...clearItems, ...publishItems], published, logs };
}

/** Compares two paths by the lower-case file name, which is the order verse.exe lists files in. */
function compareFileNames(firstPath: string, secondPath: string): number {
  const firstName = getFileName(firstPath).toLowerCase();
  const secondName = getFileName(secondPath).toLowerCase();
  if (firstName === secondName) {
    return 0;
  }
  return (firstName < secondName ? -1 : 1);
}

/**
 * Decides which file a diagnostic is shown in. Returns undefined, and writes the reason to the logs, for a diagnostic
 * that is not published: a file outside the folder (such as the standard library), or a diagnostic of the whole
 * project when the folder has no file to put it on.
 */
function resolveTargetPath(
  diagnostic: Readonly<IdeDiagnostic>,
  input: Readonly<PublishPlanInput>,
  folderDocuments: readonly OpenDocumentInfo[],
  logs: string[],
): string | undefined {
  if (diagnostic.path === '') {
    // A diagnostic of the whole project goes to the first open document, or else to the first file on disk.
    const targetPath = folderDocuments[0]?.path ?? input.findFirstFileOnDisk();
    if (targetPath === undefined) {
      logs.push(`No file to show a project-wide diagnostic in: ${diagnostic.message}`);
    }
    return targetPath;
  }

  if (!isSamePath(getProgramFolder(diagnostic.path), input.folder)) {
    logs.push(`Not published, because it is outside the folder: ${diagnostic.path}: ${diagnostic.message}`);
    return undefined;
  }
  return diagnostic.path;
}

/**
 * Converts a diagnostic of verse.exe to the LSP form. Byte offsets become UTF-16 columns using the line text.
 * When the line is not available, the byte offset is used as the column as it is, and the path is logged once.
 * A diagnostic of the whole project has no meaningful position, so it points at the start of the file.
 */
function toLspDiagnostic(
  diagnostic: Readonly<IdeDiagnostic>,
  targetPath: string,
  input: Readonly<PublishPlanInput>,
  unreadablePaths: Set<string>,
  logs: string[],
): Diagnostic {
  const convert = (line: number, byte: number): number => {
    const lineText = input.getLineText(targetPath, line);
    if (lineText === undefined) {
      if (!unreadablePaths.has(targetPath)) {
        unreadablePaths.add(targetPath);
        logs.push(`Could not read ${targetPath}; byte offsets are used as columns there.`);
      }
      return byte;
    }
    return toUtf16Column(lineText, byte);
  };

  const range = (
    diagnostic.path === '' ?
    { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } :
    {
      start: {
        line: diagnostic.range.start.line,
        character: convert(diagnostic.range.start.line, diagnostic.range.start.byte),
      },
      end: {
        line: diagnostic.range.end.line,
        character: convert(diagnostic.range.end.line, diagnostic.range.end.byte),
      },
    }
  );
  return {
    range,
    severity: LSP_SEVERITIES[diagnostic.severity],
    code: diagnostic.code,
    source: 'verse',
    message: diagnostic.message,
  };
}
