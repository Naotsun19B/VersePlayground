import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import type { LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';

import { isPathInside } from './engine-locator.ts';
import type { EngineLocation } from './engine-locator.ts';
import { buildWorkspaceProject, toSourceFolders } from './verse-project.ts';

/** Folder name prefix of the UEFN Verse extension, which bundles verse-lsp.exe. */
const UEFN_EXTENSION_FOLDER_PREFIX = 'epicgames.verse-';

/** Location of the language server inside the UEFN Verse extension. */
const BUNDLED_SERVER_PATH = path.join('bin', 'Win64', 'verse-lsp.exe');

/** File name of the generated workspace project. */
const PROJECT_FILE_NAME = 'VersePlayground.vproject';

/** Folders never searched for user code. */
const EXCLUDED_SEARCH_GLOB = '**/{node_modules,.git}/**';

/** Upper bound of .verse files listed when building the project, so a huge workspace cannot stall activation. */
const MAX_LISTED_VERSE_FILES = 5000;

/** Delay before regenerating the project after files change, so a burst of changes restarts the server once. */
const REFRESH_DELAY_MS = 1000;

/**
 * Finds verse-lsp.exe.
 *
 * A non-empty `configuredPath` wins. Otherwise the newest UEFN Verse extension folder next to this extension is used.
 * The folder is searched directly instead of through the VS Code API so that the server is found even after the
 * user disables the UEFN extension, which avoids two language servers reporting every error twice.
 */
export function findLanguageServer(configuredPath: string, extensionsDir: string): string | undefined {
  if (configuredPath.trim() !== '') {
    return (fs.existsSync(configuredPath.trim()) ? configuredPath.trim() : undefined);
  }

  let folderNames: string[];
  try {
    folderNames = fs.readdirSync(extensionsDir);
  } catch {
    return undefined;
  }

  const candidatePaths = folderNames
    .filter((folderName) => folderName.toLowerCase().startsWith(UEFN_EXTENSION_FOLDER_PREFIX))
    .sort((firstName, secondName) => compareVersions(toVersionText(secondName), toVersionText(firstName)))
    .map((folderName) => path.join(extensionsDir, folderName, BUNDLED_SERVER_PATH));
  return candidatePaths.find((candidatePath) => fs.existsSync(candidatePath));
}

/** Compares dotted version strings numerically. Returns a negative number when `first` is older. */
export function compareVersions(first: string, second: string): number {
  const firstParts = first.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const secondParts = second.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const partCount = Math.max(firstParts.length, secondParts.length);
  for (let partIndex = 0; partIndex < partCount; partIndex++) {
    const difference = (firstParts[partIndex] ?? 0) - (secondParts[partIndex] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** Returns the version part of an extension folder name such as epicgames.verse-0.0.59596594. */
function toVersionText(folderName: string): string {
  return folderName.slice(UEFN_EXTENSION_FOLDER_PREFIX.length);
}

/**
 * Runs verse-lsp.exe for the workspace.
 *
 * The workspace project is written to the extension's storage instead of the workspace, and the server is given that
 * folder as its root. The server still analyzes the user's files, because the project's packages point at them, and
 * nothing is generated in the user's folders. Diagnostics for files outside the workspace, such as the engine's
 * standard library, are dropped because the user cannot act on them.
 */
export class VerseLanguageServer implements vscode.Disposable {
  // Running client, or undefined while stopped.
  private client: LanguageClient | undefined;

  // Copy of verse-lsp.exe that the running client launched; deleted when the client stops.
  private serverCopyPath: string | undefined;

  // Pending project refresh after .verse files were created or deleted.
  private refreshTimer: NodeJS.Timeout | undefined;

  // Source folders of the running project, used to skip restarts when a change does not add or remove a folder.
  private runningFoldersKey = '';

  // Watches the workspace for .verse files appearing or disappearing.
  private readonly fileWatcher: vscode.FileSystemWatcher;

  // Folder in the extension's storage that holds the generated project and the VNI output.
  private readonly storageDir: string;

  // Where the server's messages and errors are written. The language client requires a log channel.
  private readonly outputChannel: vscode.LogOutputChannel;

  // verse-lsp.exe to run.
  private readonly serverPath: string;

  // Engine checkout whose VNI.vproject lists the standard library packages.
  private readonly engine: EngineLocation;

  /**
   * @param serverPath verse-lsp.exe to run.
   * @param engine Engine checkout whose VNI.vproject lists the standard library packages.
   * @param storageDir Folder in the extension's storage for generated files.
   */
  constructor(
    serverPath: string,
    engine: EngineLocation,
    storageDir: string,
  ) {
    this.serverPath = serverPath;
    this.engine = engine;
    this.storageDir = storageDir;
    this.outputChannel = vscode.window.createOutputChannel('Verse Language Server', { log: true });
    this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.verse', false, true, false);
    this.fileWatcher.onDidCreate(() => this.scheduleRefresh());
    this.fileWatcher.onDidDelete(() => this.scheduleRefresh());
  }

  /** Writes the workspace project and starts the server. Restarts it when it is already running. */
  async start(): Promise<void> {
    await this.stop();

    if (!fs.existsSync(this.engine.vniProjectPath)) {
      void vscode.window.showWarningMessage(
        `The language server needs ${this.engine.vniProjectPath}, which the verse.exe build creates. Run Setup.bat again.`,
      );
      return;
    }

    const userFolders = await this.listUserFolders();
    const projectRoot = path.join(this.storageDir, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const workspaceProject = buildWorkspaceProject(
      fs.readFileSync(this.engine.vniProjectPath, 'utf8'),
      userFolders,
      path.join(this.storageDir, 'vni'),
    );
    fs.writeFileSync(path.join(projectRoot, PROJECT_FILE_NAME), JSON.stringify(workspaceProject, undefined, 4));
    this.runningFoldersKey = userFolders.join('\n').toLowerCase();

    // The UEFN extension copies the server before running it too, so that updating that extension is not blocked
    // by a running server holding the executable open.
    this.serverCopyPath = path.join(os.tmpdir(), `verse-playground-lsp-${process.pid}-${Date.now()}.exe`);
    fs.copyFileSync(this.serverPath, this.serverCopyPath);

    const serverOptions: ServerOptions = { command: this.serverCopyPath, args: [] };
    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ scheme: 'file', language: 'verse' }],
      workspaceFolder: { uri: vscode.Uri.file(projectRoot), name: 'Verse Playground', index: 0 },
      outputChannel: this.outputChannel,
      middleware: {
        handleDiagnostics: (uri, diagnostics, next) => {
          // The engine checkout is often inside the workspace (Setup.bat's default is UnrealEngine/ in the
          // repository), so being in the workspace alone does not make a file the user's code.
          if (isInsideWorkspace(uri) && !isPathInside(uri.fsPath, this.engine.engineDir)) {
            next(uri, diagnostics);
          }
        },
      },
    };
    this.client = new LanguageClient('versePlayground', 'Verse Language Server', serverOptions, clientOptions);
    await this.client.start();
    this.outputChannel.appendLine(`Started ${this.serverPath} with ${userFolders.length} user folder(s).`);
  }

  /** Stops the server and removes its executable copy. Safe to call when it is not running. */
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

    if (this.serverCopyPath !== undefined) {
      // The process may still hold the file for a moment after stopping, so a failed delete is left to the OS.
      fs.rm(this.serverCopyPath, { force: true }, () => undefined);
      this.serverCopyPath = undefined;
    }
  }

  /**
   * Whether the running server reports the problems of this file, so that running it needs no problem matcher.
   * Running the file with one too would list every compiler error twice.
   */
  reportsProblemsFor(uri: vscode.Uri): boolean {
    return (
      this.client?.isRunning() === true &&
      isInsideWorkspace(uri) &&
      !isPathInside(uri.fsPath, this.engine.engineDir)
    );
  }

  /** Stops the server and the file watcher. */
  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.fileWatcher.dispose();
    void this.stop().finally(() => this.outputChannel.dispose());
  }

  /** Regenerates the project and restarts the server after files settle, when the set of folders changed. */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshIfFoldersChanged();
    }, REFRESH_DELAY_MS);
  }

  /** Restarts the server only when a folder of user code was added or removed. */
  private async refreshIfFoldersChanged(): Promise<void> {
    const userFolders = await this.listUserFolders();
    if (userFolders.join('\n').toLowerCase() !== this.runningFoldersKey) {
      await this.start();
    }
  }

  /** Lists the workspace folders that contain .verse files, leaving out the engine checkout. */
  private async listUserFolders(): Promise<string[]> {
    const verseFiles = await vscode.workspace.findFiles('**/*.verse', EXCLUDED_SEARCH_GLOB, MAX_LISTED_VERSE_FILES);
    const userFiles = verseFiles
      .map((fileUri) => fileUri.fsPath)
      .filter((filePath) => !isPathInside(filePath, this.engine.engineDir));
    return toSourceFolders(userFiles, path.dirname);
  }
}

/** Returns true when the file is inside one of the open workspace folders. */
function isInsideWorkspace(uri: vscode.Uri): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some(
    (workspaceFolder) => isPathInside(uri.fsPath, workspaceFolder.uri.fsPath),
  );
}
