import * as vscode from 'vscode';

import type { EngineProvider } from './run-commands.ts';
import { saveActiveVerseDocument } from './run-commands.ts';
import { VerseDebugSession } from './verse-debug-session.ts';

/** Debug type declared in package.json under debuggers. */
const DEBUG_TYPE = 'verse';

/** Registers the Verse debugger: its configuration provider, its in-process adapter and the debug command. */
export function registerDebugging(context: vscode.ExtensionContext, getEngine: EngineProvider): void {
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, new VerseDebugConfigurationProvider(getEngine)),
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new VerseDebugSession()),
    }),
    vscode.commands.registerCommand('versePlayground.debug', async () => {
      const document = await saveActiveVerseDocument();
      if (document === undefined) {
        return;
      }

      await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(document.uri), {
        type: DEBUG_TYPE,
        request: 'launch',
        name: 'Debug Verse file',
        program: document.uri.fsPath,
      });
    }),
  );
}

/** Fills in a Verse launch configuration so that F5 works without a launch.json. */
class VerseDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  // Finds the engine whose verse.exe runs the program.
  private readonly getEngine: EngineProvider;

  /** @param getEngine Finds the engine whose verse.exe runs the program. */
  constructor(getEngine: EngineProvider) {
    this.getEngine = getEngine;
  }

  /**
   * Turns an empty configuration (F5 with no launch.json) into one that debugs the active file, and adds the path of
   * verse.exe. Returns undefined to cancel when there is nothing to debug or no engine.
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

    const engine = this.getEngine();
    if (engine === undefined) {
      return undefined;
    }
    resolvedConfiguration.versePath = engine.versePath;
    return resolvedConfiguration;
  }
}
