// Copyright (c) 2026 Naotsun

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { findEngine, LOCAL_STATE_FILE_NAME } from './shared/engine-locator.ts';
import type { EngineLocation, EngineResolution } from './shared/engine-locator.ts';
import { toComparisonKey } from './shared/program-paths.ts';
import type { ApproveEngineParams } from './shared/protocol-types.ts';
import { BuiltinLanguageServer } from './builtin-language-server.ts';
import { registerDebugging } from './debug-registration.ts';
import { createVscodeApprovalHost, decideApproval, EngineApproval } from './engine-approval.ts';
import type { ApprovalHost } from './engine-approval.ts';
import { installGrammar } from './grammar-installer.ts';
import { decideLanguageServer } from './language-server.ts';
import type { LanguageServerHandle, LanguageServerKind, LanguageServerSkipReason } from './language-server.ts';
import { registerRunCommands } from './run-commands.ts';
import { findLanguageServer, UefnLanguageServer } from './uefn-language-server.ts';

/** Identifier of the UEFN Verse extension, which starts a language server of its own. */
const UEFN_EXTENSION_ID = 'epicgames.verse';

/** Workspace state key set when the user asked not to be told about the UEFN extension again. */
const HIDE_UEFN_NOTICE_KEY = 'versePlayground.hideUefnExtensionNotice';

/** Command that restarts the language server and forgets the engines the user refused in this window. */
const RESTART_COMMAND = 'versePlayground.restartLanguageServer';

/** Command that forgets every engine the user allowed for good, then restarts the language server. */
const FORGET_ALLOWED_ENGINES_COMMAND = 'versePlayground.forgetAllowedEngines';

// Language server of the current window, or undefined when it is not running.
let languageServer: LanguageServerHandle | undefined;

// Chain of language server starts. Each start waits for the previous one, so that a settings change, a trust grant
// and a command arriving together never leave two servers running.
let languageServerQueue: Promise<void> = Promise.resolve();

/** Called by VS Code when a workspace with .verse files opens or a Verse debugging session starts. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const windowApprovalHost = createVscodeApprovalHost(vscode, context.globalState);
  const activationGrammar = new ActivationGrammar(locateEngine(), windowApprovalHost, context.extensionPath);
  // One approval for the window, so that refusals survive the language server being recreated by a settings change.
  const windowApproval = new ReportingEngineApproval(
    windowApprovalHost,
    (engineDir) => activationGrammar.copyIfAllowedEngine(engineDir),
  );

  registerRunCommands(context, locateEngineOrExplain, (uri) => languageServer?.isReportingProblemsFor(uri) === true);
  registerDebugging(context, locateEngineOrExplain);
  context.subscriptions.push(
    vscode.commands.registerCommand(RESTART_COMMAND, async () => {
      windowApproval.forgetDenials();
      await queueLanguageServerStart(context, windowApproval, true);
    }),
    vscode.commands.registerCommand(FORGET_ALLOWED_ENGINES_COMMAND, async () => {
      await windowApproval.forgetAllowedEngines();
      await queueLanguageServerStart(context, windowApproval, false);
    }),
    vscode.workspace.onDidChangeConfiguration(async (changeEvent) => {
      if (changeEvent.affectsConfiguration('versePlayground')) {
        await queueLanguageServerStart(context, windowApproval, false);
      }
    }),
    // Matters when the user lets the extension run in restricted mode: nothing starts until the workspace is trusted.
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      activationGrammar.copyIfTrusted();
      await queueLanguageServerStart(context, windowApproval, false);
    }),
  );

  // The engine found here only decides where the grammar comes from. The language server is decided even without one:
  // the built-in server finds the engine of each folder itself, and running a file explains a missing engine.
  activationGrammar.copyIfTrusted();
  await queueLanguageServerStart(context, windowApproval, false);
}

/** Called by VS Code when the window closes or the extension is disabled. */
export async function deactivate(): Promise<void> {
  await stopLanguageServer();
}

/**
 * Finds the engine from the setting or the local state file that Setup.bat writes, and how it was found.
 *
 * @param startFolder Folder searched first for the local state file, such as the folder of the program to run. The
 *   folder of the active file and the workspace folders are searched after it.
 */
function locateEngine(startFolder?: string): EngineResolution | undefined {
  const configuredEngineDir = vscode.workspace.getConfiguration('versePlayground').get<string>('engineDir', '');
  const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map((workspaceFolder) => workspaceFolder.uri.fsPath);
  const activeFile = vscode.window.activeTextEditor?.document.uri;
  const programFolders = (startFolder !== undefined ? [startFolder] : []);
  const activeFolders = (activeFile?.scheme === 'file' ? [path.dirname(activeFile.fsPath)] : []);
  return findEngine(configuredEngineDir, [...programFolders, ...activeFolders, ...workspacePaths]);
}

/**
 * Like {@link locateEngine}, but tells the user what to do when there is no usable verse.exe.
 *
 * @param startFolder Folder searched first for the local state file, such as the folder of the program to run.
 */
function locateEngineOrExplain(startFolder?: string): EngineLocation | undefined {
  const engine = locateEngine(startFolder)?.location;
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
 * Returns whether the engine may be run without asking the user: it was found through a route that is trusted by
 * itself, or the user allowed it for good. The records of this window are left out, because nothing is asked here.
 */
function isAllowedWithoutAsking(
  activationEngine: Readonly<EngineResolution>,
  windowApprovalHost: Readonly<ApprovalHost>,
): boolean {
  const approvalDecision = decideApproval({
    engineKey: toComparisonKey(activationEngine.location.engineDir),
    source: activationEngine.source,
    settingScope: windowApprovalHost.getEngineDirSettingScope(),
    trustedFolders: windowApprovalHost.getTrustedFolders(),
    approvedGlobally: new Set(windowApprovalHost.readAllowedEngines()),
    usedInWindow: new Set<string>(),
    deniedInWindow: new Set<string>(),
  });
  return approvalDecision === 'allow';
}

/**
 * Copies the Verse grammar from the engine found at activation, but only once that engine may be run.
 *
 * The grammar and the language configuration come from the engine folder and stay in the extension after a reload, so
 * a folder the user did not trust must not provide them. The copy happens at most once per window, and forgetting the
 * allowed engines does not remove it.
 */
class ActivationGrammar {
  // Engine found at activation whose grammar is not copied yet, or undefined when there is none or it was copied.
  private pendingEngine: Readonly<EngineResolution> | undefined;

  // Tells which settings and folders are trusted and which engines the user allowed.
  private readonly windowApprovalHost: Readonly<ApprovalHost>;

  // Folder of this extension, which receives the copy.
  private readonly extensionPath: string;

  /**
   * @param activationEngine Engine found at activation, or undefined when there was none.
   * @param windowApprovalHost Tells which settings and folders are trusted and which engines the user allowed.
   * @param extensionPath Folder of this extension, which receives the copy.
   */
  constructor(
    activationEngine: Readonly<EngineResolution> | undefined,
    windowApprovalHost: Readonly<ApprovalHost>,
    extensionPath: string,
  ) {
    this.pendingEngine = activationEngine;
    this.windowApprovalHost = windowApprovalHost;
    this.extensionPath = extensionPath;
  }

  /** Copies the grammar when the engine needs no confirmation, or the user allowed it in an earlier window. */
  copyIfTrusted(): void {
    if (this.pendingEngine !== undefined && isAllowedWithoutAsking(this.pendingEngine, this.windowApprovalHost)) {
      this.copy(this.pendingEngine.location);
    }
  }

  /** Copies the grammar when the engine the language server was just allowed to run is the one found at activation. */
  copyIfAllowedEngine(engineDir: string): void {
    if (
      this.pendingEngine !== undefined &&
      toComparisonKey(engineDir) === toComparisonKey(this.pendingEngine.location.engineDir)
    ) {
      this.copy(this.pendingEngine.location);
    }
  }

  /** Copies the grammar of the engine and stops waiting for it. */
  private copy(engine: Readonly<EngineLocation>): void {
    this.pendingEngine = undefined;
    updateGrammar(engine, this.extensionPath);
  }
}

/** The window's engine approval, which also reports each allowed engine so that its grammar can be copied. */
class ReportingEngineApproval extends EngineApproval {
  // Called with the engine folder each time a request to run that engine's verse.exe was allowed.
  private readonly onAllowed: (engineDir: string) => void;

  /**
   * @param host The parts of VS Code that the approval needs.
   * @param onAllowed Called with the engine folder each time a request to run that engine's verse.exe was allowed.
   */
  constructor(host: Readonly<ApprovalHost>, onAllowed: (engineDir: string) => void) {
    super(host);
    this.onAllowed = onAllowed;
  }

  /** Answers the approveEngine request like the base class, then reports the engine when it was allowed. */
  override async approve(params: Readonly<ApproveEngineParams>): Promise<boolean> {
    const isAllowed = await super.approve(params);
    if (isAllowed) {
      this.onAllowed(params.engineDir);
    }
    return isAllowed;
  }
}

/**
 * Starts the language server, or restarts it with the current settings, after the start that is still running.
 *
 * @param windowApproval Decides whether an engine's verse.exe may be run. Shared by every server of the window.
 * @param shouldExplain Whether to tell the user why the server did not start, for an explicit restart command.
 */
function queueLanguageServerStart(
  context: vscode.ExtensionContext,
  windowApproval: EngineApproval,
  shouldExplain: boolean,
): Promise<void> {
  const queuedStart = languageServerQueue.then(async () => startLanguageServer(context, windowApproval, shouldExplain));
  // A failed start must not block the starts queued after it; the caller still sees the failure.
  languageServerQueue = queuedStart.catch(() => undefined);
  return queuedStart;
}

/**
 * Starts the language server, or restarts it with the current settings.
 *
 * Nothing starts while the server is disabled, while the workspace is not trusted (the folder decides which verse.exe
 * runs), or while the UEFN Verse extension is enabled, because that extension runs a server of its own and every
 * problem would be reported twice. Otherwise the kind setting decides. The built-in server starts even without an
 * engine, because it finds the engine of each folder itself; the UEFN server needs the engine's Verse packages.
 *
 * @param windowApproval Decides whether an engine's verse.exe may be run. Shared by every server of the window.
 * @param shouldExplain Whether to tell the user why the server did not start, for an explicit restart command.
 */
async function startLanguageServer(
  context: vscode.ExtensionContext,
  windowApproval: EngineApproval,
  shouldExplain: boolean,
): Promise<void> {
  await stopLanguageServer();

  const configuration = vscode.workspace.getConfiguration('versePlayground');
  const kind = readLanguageServerKind(configuration);
  const uefnEngine = (kind === 'uefn' ? locateEngine()?.location : undefined);
  const startDecision = decideLanguageServer({
    isEnabled: configuration.get<boolean>('languageServer.enabled', true),
    isTrusted: vscode.workspace.isTrusted,
    isUefnExtensionEnabled: vscode.extensions.getExtension(UEFN_EXTENSION_ID) !== undefined,
    kind,
    isEngineFound: uefnEngine !== undefined,
  });
  if (startDecision.action === 'skip') {
    explainSkippedStart(context, startDecision.reason, kind, shouldExplain);
    return;
  }

  if (startDecision.kind === 'builtin') {
    await runLanguageServer(new BuiltinLanguageServer(context.extensionPath, windowApproval));
    return;
  }

  // The decision starts the UEFN server only with an engine; this check only narrows the type.
  if (uefnEngine === undefined) {
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
  const storageDir = path.join(storageUri.fsPath, 'language-server');
  await runLanguageServer(new UefnLanguageServer(serverPath, uefnEngine, storageDir));
}

/** Makes the server the window's language server and starts it, telling the user when it fails to start. */
async function runLanguageServer(newServer: LanguageServerHandle): Promise<void> {
  languageServer = newServer;
  try {
    await newServer.start();
  } catch (error) {
    void vscode.window.showErrorMessage(`The Verse language server failed to start: ${String(error)}`);
  }
}

/** Stops the window's language server and releases it. Safe to call when none is running. */
async function stopLanguageServer(): Promise<void> {
  // Cleared first, so that running a file while the server stops keeps its problem matcher.
  const runningServer = languageServer;
  languageServer = undefined;
  await runningServer?.stop();
  runningServer?.dispose();
}

/** Reads the languageServer.kind setting. Any value other than "uefn" means the built-in server, the default. */
function readLanguageServerKind(configuration: Readonly<vscode.WorkspaceConfiguration>): LanguageServerKind {
  return (configuration.get<string>('languageServer.kind', 'builtin') === 'uefn' ? 'uefn' : 'builtin');
}

/**
 * Tells the user why no language server started, where a message helps. A disabled server needs none because the user
 * turned it off, and an untrusted workspace needs none because VS Code shows its restricted mode itself.
 *
 * @param kind The languageServer.kind setting, which the notice about the UEFN extension depends on.
 * @param shouldExplain Whether this is an explicit restart command, which always explains.
 */
function explainSkippedStart(
  context: vscode.ExtensionContext,
  reason: LanguageServerSkipReason,
  kind: LanguageServerKind,
  shouldExplain: boolean,
): void {
  switch (reason) {
    case 'disabled': {
      break;
    }
    case 'untrusted': {
      break;
    }
    case 'uefnExtensionEnabled': {
      // Not awaited, so that a notice waiting for an answer does not hold up the next start.
      void explainUefnExtension(context, kind, shouldExplain);
      break;
    }
    case 'engineNotFound': {
      // Only the UEFN server needs the engine at startup. Without a restart command, running a file explains it.
      if (shouldExplain) {
        locateEngineOrExplain();
      }
      break;
    }
  }
}

/** Suggests disabling the UEFN Verse extension for this workspace, unless the user hid the suggestion. */
async function explainUefnExtension(
  context: vscode.ExtensionContext,
  kind: LanguageServerKind,
  shouldExplain: boolean,
): Promise<void> {
  if (!shouldExplain && context.workspaceState.get<boolean>(HIDE_UEFN_NOTICE_KEY, false)) {
    return;
  }

  const selection = await vscode.window.showInformationMessage(
    describeUefnExtensionConflict(kind),
    'Show Extension',
    "Don't Show Again",
  );
  if (selection === 'Show Extension') {
    await vscode.commands.executeCommand('workbench.extensions.search', `@id:${UEFN_EXTENSION_ID}`);
  } else if (selection === "Don't Show Again") {
    await context.workspaceState.update(HIDE_UEFN_NOTICE_KEY, true);
  }
}

/** Returns the notice shown while the UEFN Verse extension keeps Verse Playground's language server from starting. */
function describeUefnExtensionConflict(kind: LanguageServerKind): string {
  if (kind === 'uefn') {
    return (
      'The UEFN Verse extension is enabled, so Verse Playground does not start its own language server. ' +
      'Disable the UEFN extension for this workspace and reload to get errors, hover and go to definition for the ' +
      'Verse version of your engine. Verse Playground keeps using the language server that comes with it.'
    );
  }
  return (
    'The UEFN Verse extension is enabled, so Verse Playground does not start its own language server. ' +
    'Disable the UEFN extension for this workspace and reload to get errors, hover and go to definition from the ' +
    'verse.exe of your engine.'
  );
}
