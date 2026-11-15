// Copyright (c) 2026 Naotsun

import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, TransportKind } from 'vscode-languageclient/node';
import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';

import type { EngineApproval } from './engine-approval.ts';
import type { LanguageServerHandle } from './language-server.ts';
import { toEngineLocation, LOCAL_STATE_FILE_NAME } from './shared/engine-locator.ts';
import { getProgramFolder, isVerseFile, toComparisonKey } from './shared/program-paths.ts';
import { isCoveredByLanguageServer } from './shared/problem-coverage.ts';
import {
  APPROVE_ENGINE_REQUEST,
  CHECK_RESULT_NOTIFICATION,
  UNAVAILABLE_NOTIFICATION,
} from './shared/protocol-types.ts';
import type {
  ApproveEngineParams,
  CheckResult,
  ServerInitializationOptions,
  UnavailableParams,
  VersionMap,
} from './shared/protocol-types.ts';

/** Command that restarts the language server, offered as a button of the notices. */
const RESTART_COMMAND = 'versePlayground.restartLanguageServer';

/** Label of the button that restarts the language server. */
const RESTART_LABEL = 'Restart Language Server';

/** Label of the button that opens the settings. */
const OPEN_SETTINGS_LABEL = 'Open Settings';

/** Setting that switches between the built-in and the UEFN language server. */
const KIND_SETTING = 'versePlayground.languageServer.kind';

/**
 * Runs the language server bundled with this extension (dist/server.js) in a separate Node process.
 *
 * The server analyzes each folder with the engine's verse.exe. This class answers its requests to run an engine,
 * tells the user when the analysis cannot be used, and remembers the latest state of every folder so that running a
 * file does not report the same problems a second time.
 */
export class BuiltinLanguageServer implements LanguageServerHandle {
  // Running client, or undefined while stopped.
  private client: LanguageClient | undefined;

  // Watchers that tell the server about file changes; they live as long as the client.
  private watchers: vscode.FileSystemWatcher[] = [];

  // Latest checkResult by comparison key of the folder. Discarded when the client changes state.
  private readonly checkResults = new Map<string, CheckResult>();

  // Engine checkout used for each folder, by comparison key of the folder, as the server last asked about it.
  private readonly engineDirsByFolder = new Map<string, string>();

  // Comparison keys of the engines the user has already been told about. Cleared by a restart.
  private readonly notifiedEngines = new Set<string>();

  // Where the server's messages and errors are written. The language client requires a log channel.
  private readonly outputChannel: vscode.LogOutputChannel;

  // Folder of this extension, which holds dist/server.js.
  private readonly extensionPath: string;

  // Decides whether an engine's verse.exe may be run.
  private readonly approval: EngineApproval;

  /**
   * @param extensionPath Folder of this extension, which holds dist/server.js.
   * @param approval Decides whether an engine's verse.exe may be run. Shared so that refusals outlive this object.
   */
  constructor(
    extensionPath: string,
    approval: EngineApproval,
  ) {
    this.extensionPath = extensionPath;
    this.approval = approval;
    this.outputChannel = vscode.window.createOutputChannel('Verse Language Server', { log: true });
  }

  /** Starts the server. Restarts it when it is already running, and shows the notices again. */
  async start(): Promise<void> {
    await this.stop();
    this.notifiedEngines.clear();

    const initializationOptions: ServerInitializationOptions = {
      configuredEngineDir: vscode.workspace.getConfiguration('versePlayground').get<string>('engineDir', ''),
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((workspaceFolder) => workspaceFolder.uri.fsPath),
    };
    const serverModule = path.join(this.extensionPath, 'dist', 'server.js');
    const serverOptions: ServerOptions = {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: { module: serverModule, transport: TransportKind.ipc },
    };

    this.watchers = [
      vscode.workspace.createFileSystemWatcher('**/*.verse'),
      vscode.workspace.createFileSystemWatcher(`**/${LOCAL_STATE_FILE_NAME}`),
    ];
    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: 'file', language: 'verse' }],
      outputChannel: this.outputChannel,
      initializationOptions,
      synchronize: { fileEvents: this.watchers },
    };

    const newClient = new LanguageClient('versePlayground', 'Verse Language Server', serverOptions, clientOptions);
    newClient.onDidChangeState(() => this.checkResults.clear());
    newClient.onRequest(APPROVE_ENGINE_REQUEST, (params: ApproveEngineParams) => this.approveEngine(params));
    newClient.onNotification(CHECK_RESULT_NOTIFICATION, (result: CheckResult) => {
      this.checkResults.set(toComparisonKey(result.folder), result);
    });
    newClient.onNotification(UNAVAILABLE_NOTIFICATION, (params: UnavailableParams) => this.explain(params));
    this.client = newClient;

    try {
      await newClient.start();
    } catch (error) {
      this.outputChannel.appendLine(`Starting the server failed: ${String(error)}`);
      throw error;
    }
  }

  /** Stops the server. Safe to call when it is not running. */
  async stop(): Promise<void> {
    const runningClient = this.client;
    this.client = undefined;
    if (runningClient !== undefined) {
      try {
        await runningClient.stop();
      } catch (error) {
        this.outputChannel.appendLine(`Stopping the server failed: ${String(error)}`);
      }
    }

    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    this.checkResults.clear();
  }

  /**
   * Whether the latest analysis of the file's folder succeeded and saw exactly the documents that are open now, so
   * that running the file needs no problem matcher. Running it with one too would list every error twice.
   */
  isReportingProblemsFor(uri: vscode.Uri): boolean {
    if (this.client?.isRunning() !== true) {
      return false;
    }

    const folder = getProgramFolder(uri.fsPath);
    const folderKey = toComparisonKey(folder);
    return isCoveredByLanguageServer(
      {
        scheme: uri.scheme,
        fsPath: uri.fsPath,
        engineDir: this.engineDirsByFolder.get(folderKey),
      },
      this.checkResults.get(folderKey),
      collectOpenVersions(folderKey),
    );
  }

  /** Stops the server and releases the output channel. */
  dispose(): void {
    void this.stop().finally(() => this.outputChannel.dispose());
  }

  /** Answers the approveEngine request, and remembers which engine the folder uses. */
  private async approveEngine(params: Readonly<ApproveEngineParams>): Promise<boolean> {
    this.engineDirsByFolder.set(toComparisonKey(params.folder), params.engineDir);
    return this.approval.approve(params);
  }

  /** Tells the user why the analysis cannot be used with the engine, once per engine until the next restart. */
  private explain(params: Readonly<UnavailableParams>): void {
    const engineKey = toComparisonKey(params.engineDir);
    if (this.notifiedEngines.has(engineKey)) {
      return;
    }
    this.notifiedEngines.add(engineKey);

    // The path in the message comes from the server; fall back to the engine layout when it is empty.
    const versePath = (params.versePath !== '' ? params.versePath : toEngineLocation(params.engineDir).versePath);
    this.outputChannel.appendLine(`The analysis is unavailable (${params.reason}) for ${versePath}.`);

    switch (params.reason) {
      case 'missing':
        void vscode.window.showWarningMessage(`${versePath} does not exist. Run Setup.bat again to build it.`);
        break;
      case 'unsupported':
        void this.showWithButtons(
          `${versePath} cannot check Verse files for the editor, so errors, hover and go to definition are off. ` +
          'Run Setup.bat again with an engine version that the README lists as supported, ' +
          `or set ${KIND_SETTING} to uefn.`,
          [RESTART_LABEL, OPEN_SETTINGS_LABEL],
        );
        break;
      case 'protocol':
        void this.showWithButtons(
          'This verse.exe and Verse Playground are from different releases. Run Setup.bat again.',
          [RESTART_LABEL],
        );
        break;
    }
  }

  /** Shows a warning with buttons and runs the action of the clicked one. */
  private async showWithButtons(message: string, buttons: readonly string[]): Promise<void> {
    const clickedLabel = await vscode.window.showWarningMessage(message, ...buttons);
    if (clickedLabel === RESTART_LABEL) {
      await vscode.commands.executeCommand(RESTART_COMMAND);
    } else if (clickedLabel === OPEN_SETTINGS_LABEL) {
      await vscode.commands.executeCommand('workbench.action.openSettings', KIND_SETTING);
    }
  }
}

/** Returns the versions of the open Verse documents of the folder, by document URI string. */
function collectOpenVersions(folderKey: string): VersionMap {
  const versions: Record<string, number> = {};
  for (const document of vscode.workspace.textDocuments) {
    if (
      document.uri.scheme === 'file' &&
      isVerseFile(document.uri.fsPath) &&
      toComparisonKey(getProgramFolder(document.uri.fsPath)) === folderKey
    ) {
      versions[document.uri.toString()] = document.version;
    }
  }
  return versions;
}
