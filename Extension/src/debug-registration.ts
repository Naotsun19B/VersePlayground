// Copyright (c) 2026 Naotsun

import * as path from 'node:path';
import * as vscode from 'vscode';

import { pickArgumentLine } from './argument-picker.ts';
import { splitArguments } from './command-line.ts';
import { resolveProgramPath } from './program-documents.ts';
import type { EngineProvider } from './run-commands.ts';
import { saveActiveVerseDocument, saveProgramDocuments } from './run-commands.ts';
import { VerseDebugSession } from './verse-debug-session.ts';

/** Debug type declared in package.json under debuggers. */
const DEBUG_TYPE = 'verse';

/** Registers the Verse debugger: its configuration provider, its in-process adapter and the debug commands. */
export function registerDebugging(context: vscode.ExtensionContext, getEngine: EngineProvider): void {
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new VerseDebugConfigurationProvider(getEngine)),
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new VerseDebugSession()),
    }),
    vscode.commands.registerCommand('versePlayground.debug', async () => {
      await debugActiveFile([]);
    }),
    vscode.commands.registerCommand('versePlayground.debugWithArguments', async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document === undefined || document.languageId !== 'verse') {
        void vscode.window.showWarningMessage('Open a .verse file to debug it.');
        return;
      }

      const argumentLine = await pickArgumentLine(context, document.uri.fsPath, 'Debug Verse File with Arguments');
      if (argumentLine === undefined) {
        return;
      }
      await debugActiveFile(splitArguments(argumentLine));
    }),
  );
}

/** Saves the active Verse file and starts debugging it, passing the arguments to Main in Args. */
async function debugActiveFile(programArguments: readonly string[]): Promise<void> {
  const document = await saveActiveVerseDocument();
  if (document === undefined) {
    return;
  }

  await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(document.uri), {
    type: DEBUG_TYPE,
    request: 'launch',
    name: 'Debug Verse file',
    program: document.uri.fsPath,
    args: [...programArguments],
  });
}

/** Fills in a Verse launch configuration so that F5 works without a launch.json. */
class VerseDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  // Finds the engine whose verse.exe runs the program, searching from the folder of the program.
  private readonly getEngine: EngineProvider;

  /** @param getEngine Finds the engine whose verse.exe runs the program, searching from the folder of the program. */
  constructor(getEngine: EngineProvider) {
    this.getEngine = getEngine;
  }

  /**
   * Turns an empty configuration (F5 with no launch.json) into one that debugs the active file. Returns undefined to
   * cancel when there is nothing to debug.
   */
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    debugConfiguration: vscode.DebugConfiguration,
  ): vscode.DebugConfiguration | undefined {
    const resolvedConfiguration = { ...debugConfiguration };
    if (resolvedConfiguration.type === undefined && resolvedConfiguration.request === undefined) {
      const activeDocument = vscode.window.activeTextEditor?.document;
      if (activeDocument?.languageId !== 'verse') {
        void vscode.window.showWarningMessage('Open a .verse file to debug it.');
        return undefined;
      }
      resolvedConfiguration.type = DEBUG_TYPE;
      resolvedConfiguration.request = 'launch';
      resolvedConfiguration.name = 'Debug Verse file';
      resolvedConfiguration.program = '${file}';
    }

    return resolvedConfiguration;
  }

  /**
   * Runs after VS Code substituted the variables of the configuration, so `program` is final here. Makes it an
   * absolute path, saves the unsaved Verse files of its folder, and adds the path of the verse.exe that belongs to that
   * folder. This runs for launch.json and the Run and Debug view as well as for the commands. Returns undefined to
   * cancel when the program is unknown, a file cannot be saved, or there is no engine.
   */
  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    debugConfiguration: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const programPath = resolveProgramPath(debugConfiguration.program, folder?.uri.fsPath);
    if (programPath === undefined) {
      void vscode.window.showWarningMessage(
        'The program to debug is not an absolute path, and there is no workspace folder to resolve it against.',
      );
      return undefined;
    }

    if (!(await saveProgramDocuments(programPath))) {
      return undefined;
    }

    const engine = this.getEngine(path.dirname(programPath));
    if (engine === undefined) {
      return undefined;
    }
    return { ...debugConfiguration, program: programPath, versePath: engine.versePath };
  }
}
