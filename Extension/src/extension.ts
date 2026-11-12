import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { findEngine, LOCAL_STATE_FILE_NAME } from './engine-locator.ts';
import type { EngineLocation } from './engine-locator.ts';
import { registerDebugging } from './debug-registration.ts';
import { installGrammar } from './grammar-installer.ts';
import { findLanguageServer, VerseLanguageServer } from './language-server.ts';
import { registerRunCommands } from './run-commands.ts';

/** Identifier of the UEFN Verse extension, which starts a language server of its own. */
const UEFN_EXTENSION_ID = 'epicgames.verse';

/** Workspace state key set when the user asked not to be told about the UEFN extension again. */
const HIDE_UEFN_NOTICE_KEY = 'versePlayground.hideUefnExtensionNotice';

// Language server of the current window, or undefined when it is not running.
let languageServer: VerseLanguageServer | undefined;

/** Called by VS Code when a workspace with .verse files opens or a Verse debugging session starts. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const getEngine = (): EngineLocation | undefined => locateEngineOrExplain();
  registerRunCommands(context, getEngine, (uri) => languageServer?.reportsProblemsFor(uri) === true);
  registerDebugging(context, getEngine);
  context.subscriptions.push(
    vscode.commands.registerCommand('versePlayground.restartLanguageServer', async () => {
      await startLanguageServer(context, true);
    }),
    vscode.workspace.onDidChangeConfiguration(async (changeEvent) => {
      if (changeEvent.affectsConfiguration('versePlayground')) {
        await startLanguageServer(context, false);
      }
    }),
  );

  const engine = locateEngine();
  if (engine === undefined) {
    // Running a file reports the missing engine with instructions; there is nothing else to set up.
    return;
  }

  updateGrammar(engine, context.extensionPath);
  await startLanguageServer(context, false);
}

/** Called by VS Code when the window closes or the extension is disabled. */
export async function deactivate(): Promise<void> {
  await languageServer?.stop();
  languageServer = undefined;
}

/** Finds the engine from the setting or the local state file that Setup.bat writes. */
function locateEngine(): EngineLocation | undefined {
  const configuredEngineDir = vscode.workspace.getConfiguration('versePlayground').get<string>('engineDir', '');
  const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((workspaceFolder) => workspaceFolder.uri.fsPath);
  const activeFile = vscode.window.activeTextEditor?.document.uri;
  const startFolders = (
    activeFile?.scheme === 'file' ?
    [path.dirname(activeFile.fsPath), ...workspacePaths] :
    workspacePaths
  );
  return findEngine(configuredEngineDir, startFolders);
}

/** Like {@link locateEngine}, but tells the user what to do when there is no usable verse.exe. */
function locateEngineOrExplain(): EngineLocation | undefined {
  const engine = locateEngine();
  if (engine === undefined) {
    void vscode.window.showErrorMessage(
      `verse.exe was not found. Run Setup.bat from VersePlayground, open the folder that contains ` +
        `${LOCAL_STATE_FILE_NAME}, or set versePlayground.engineDir.`,
      'Open Settings',
    ).then((selection) => {
      if (selection === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'versePlayground.engineDir');
      }
    });
    return undefined;
  }

  if (!fs.existsSync(engine.versePath)) {
    void vscode.window.showErrorMessage(`${engine.versePath} does not exist. Run Setup.bat again to build it.`);
    return undefined;
  }
  return engine;
}

/** Copies the engine's Verse grammar into the extension and offers a reload when it changed. */
function updateGrammar(engine: EngineLocation, extensionPath: string): void {
  let installResult: ReturnType<typeof installGrammar>;
  try {
    installResult = installGrammar(engine, extensionPath);
  } catch (error) {
    void vscode.window.showWarningMessage(`The Verse syntax highlighting could not be installed: ${String(error)}`);
    return;
  }

  switch (installResult) {
    case 'installed': {
      void vscode.window.showInformationMessage(
        'Verse syntax highlighting was copied from your engine checkout. Reload the window to use it.',
        'Reload Window',
      ).then((selection) => {
        if (selection === 'Reload Window') {
          void vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      });
      break;
    }
    case 'missing': {
      void vscode.window.showWarningMessage(
        `The engine checkout has no Verse grammar under ${engine.grammarDir}. Run Setup.bat again to fetch it.`,
      );
      break;
    }
    case 'unchanged': {
      break;
    }
  }
}

/**
 * Starts the language server, or restarts it with the current settings.
 *
 * While the UEFN Verse extension is enabled the server is not started, because that extension runs a server of its
 * own and every problem would be reported twice. The user is asked to disable it for the workspace instead.
 *
 * @param shouldExplain Whether to tell the user why the server did not start, for an explicit restart command.
 */
async function startLanguageServer(context: vscode.ExtensionContext, shouldExplain: boolean): Promise<void> {
  await languageServer?.stop();
  languageServer?.dispose();
  languageServer = undefined;

  const configuration = vscode.workspace.getConfiguration('versePlayground');
  if (!configuration.get<boolean>('languageServer.enabled', true)) {
    return;
  }

  const engine = locateEngine();
  if (engine === undefined) {
    if (shouldExplain) {
      locateEngineOrExplain();
    }
    return;
  }

  if (vscode.extensions.getExtension(UEFN_EXTENSION_ID) !== undefined) {
    await explainUefnExtension(context, shouldExplain);
    return;
  }

  const serverPath = findLanguageServer(
    configuration.get<string>('languageServer.path', ''),
    path.dirname(context.extensionPath),
  );
  if (serverPath === undefined) {
    if (shouldExplain) {
      void vscode.window.showInformationMessage(
        'No Verse language server was found. It comes with the Verse extension that UEFN installs into VS Code; ' +
          'running and debugging work without it.',
      );
    }
    return;
  }

  const storageUri = context.storageUri ?? context.globalStorageUri;
  languageServer = new VerseLanguageServer(serverPath, engine, path.join(storageUri.fsPath, 'language-server'));
  try {
    await languageServer.start();
  } catch (error) {
    void vscode.window.showErrorMessage(`The Verse language server failed to start: ${String(error)}`);
  }
}

/** Suggests disabling the UEFN Verse extension for this workspace, unless the user hid the suggestion. */
async function explainUefnExtension(context: vscode.ExtensionContext, shouldExplain: boolean): Promise<void> {
  if (!shouldExplain && context.workspaceState.get<boolean>(HIDE_UEFN_NOTICE_KEY, false)) {
    return;
  }

  const selection = await vscode.window.showInformationMessage(
    'The UEFN Verse extension is enabled, so Verse Playground does not start its own language server. ' +
      'Disable the UEFN extension for this workspace and reload to get errors and completion for the Verse ' +
      'version of your engine. Verse Playground keeps using the language server that comes with it.',
    'Show Extension',
    "Don't Show Again",
  );
  if (selection === 'Show Extension') {
    await vscode.commands.executeCommand('workbench.extensions.search', `@id:${UEFN_EXTENSION_ID}`);
  } else if (selection === "Don't Show Again") {
    await context.workspaceState.update(HIDE_UEFN_NOTICE_KEY, true);
  }
}
