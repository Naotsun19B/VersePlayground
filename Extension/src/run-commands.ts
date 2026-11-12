// Copyright (c) 2026 Naotsun

import * as path from 'node:path';
import * as vscode from 'vscode';

import { pickArgumentLine } from './argument-picker.ts';
import { splitArguments } from './command-line.ts';
import type { EngineLocation } from './engine-locator.ts';

/** Task type declared in package.json under taskDefinitions. */
const TASK_TYPE = 'verse';

/** Problem matcher declared in package.json. It turns compiler errors into entries of the Problems panel. */
const PROBLEM_MATCHER = '$verse';

/** Returns the engine to run with, or undefined after telling the user that none was found. */
export type EngineProvider = () => EngineLocation | undefined;

/** Returns whether the language server already reports the problems of the file, so running it needs no matcher. */
export type LanguageServerCoverage = (uri: vscode.Uri) => boolean;

/** Registers the commands that run the Verse file in the active editor. */
export function registerRunCommands(
  context: vscode.ExtensionContext,
  getEngine: EngineProvider,
  isCoveredByLanguageServer: LanguageServerCoverage,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('versePlayground.run', async () => {
      await runActiveFile(getEngine, isCoveredByLanguageServer, []);
    }),
    vscode.commands.registerCommand('versePlayground.runWithArguments', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document === undefined || document.languageId !== 'verse') {
        void vscode.window.showWarningMessage('Open a .verse file to run it.');
        return;
      }

      const argumentLine = await pickArgumentLine(context, document.uri.fsPath, 'Run Verse File with Arguments');
      if (argumentLine === undefined) {
        return;
      }
      await runActiveFile(getEngine, isCoveredByLanguageServer, splitArguments(argumentLine));
    }),
  );
}

/**
 * Saves the active Verse file and runs it with verse.exe as a task.
 *
 * A task runs in a terminal, so programs that call InputLine can read what the user types, and the problem matcher
 * fills the Problems panel from compiler errors. VS Code clears those problems when the task runs again. The matcher
 * is left out while the language server reports the file's problems, so that each error is listed once.
 */
async function runActiveFile(
  getEngine: EngineProvider,
  isCoveredByLanguageServer: LanguageServerCoverage,
  programArguments: readonly string[],
): Promise<void> {
  const document = await saveActiveVerseDocument();
  if (document === undefined) {
    return;
  }

  const engine = getEngine();
  if (engine === undefined) {
    return;
  }

  const filePath = document.uri.fsPath;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const task = new vscode.Task(
    { type: TASK_TYPE, file: filePath, args: [...programArguments] },
    workspaceFolder ?? vscode.TaskScope.Workspace,
    `Run ${path.basename(filePath)}`,
    'Verse',
    new vscode.ProcessExecution(engine.versePath, [filePath, ...programArguments], { cwd: path.dirname(filePath) }),
    (isCoveredByLanguageServer(document.uri) ? [] : PROBLEM_MATCHER),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    // Focus the terminal so that a program waiting in InputLine gets the keyboard right away.
    focus: true,
    clear: true,
    panel: vscode.TaskPanelKind.Shared,
    echo: true,
  };
  await vscode.tasks.executeTask(task);
}

/**
 * Returns the Verse document of the active editor after saving it, because verse.exe reads the file from disk.
 * Shows a message and returns undefined when the active editor is not a Verse file or the save fails.
 */
export async function saveActiveVerseDocument(): Promise<vscode.TextDocument | undefined> {
  const document = vscode.window.activeTextEditor?.document;
  if (document === undefined || document.languageId !== 'verse') {
    void vscode.window.showWarningMessage('Open a .verse file to run it.');
    return undefined;
  }

  if (document.uri.scheme !== 'file') {
    void vscode.window.showWarningMessage('Save the Verse file to disk before running it.');
    return undefined;
  }

  if (document.isDirty && !(await document.save())) {
    void vscode.window.showWarningMessage('The Verse file could not be saved, so it was not run.');
    return undefined;
  }
  return document;
}
