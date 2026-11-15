// Copyright (c) 2026 Naotsun

/*
 * Entry point of the language server, which the extension bundles as dist/server.js and starts in a plain Node process
 * connected over IPC. It never imports vscode.
 *
 * Every folder that holds an open .verse file is one program. For each one the server finds the engine, asks the
 * client whether its verse.exe may be run, pings it, and then lets the check scheduler decide when to analyze the
 * folder. Hover and go to definition run verse.exe directly, without a debounce. This file only connects the parts:
 * the decisions are made by the scheduler, the engine registry, the publish plan and the process runner.
 */

import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createConnection,
  MarkupKind,
  TextDocuments,
  TextDocumentSyncKind,
  type CancellationToken,
  type Connection,
  type FileEvent,
  type Hover,
  type InitializeResult,
  type Location,
  type Range,
  type TextDocumentPositionParams,
  type WorkspaceFolder,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { findEngine, type EngineLocation } from '../shared/engine-locator.ts';
import {
  getProgramFolder,
  isInsideEngine,
  isInsideFolder,
  isSamePath,
  isVerseFile,
  toComparisonKey,
} from '../shared/program-paths.ts';
import {
  APPROVE_ENGINE_REQUEST,
  CHECK_RESULT_NOTIFICATION,
  RESTART_ANALYSIS_REQUEST,
  UNAVAILABLE_NOTIFICATION,
  type ApproveEngineResult,
  type ServerInitializationOptions,
} from '../shared/protocol-types.ts';
import { CheckScheduler, SYSTEM_CLOCK, type CheckJob, type CheckOutcome } from './check-scheduler.ts';
import { DocumentTexts } from './document-texts.ts';
import { EngineRegistry, type PingProcessResult, type PrepareResult } from './engine-registry.ts';
import { FolderWatcher, MAX_WATCHED_FOLDERS, type WatchResult } from './folder-watcher.ts';
import {
  buildCheckRequest,
  buildLookupRequest,
  buildPingRequest,
  type IdeOverride,
  type IdeRange,
  type IdeSuccess,
} from './ide-protocol.ts';
import { canLookUp } from './lookup-gate.ts';
import { planClear, planPublish, type OpenDocumentInfo, type PublishPlan } from './publish-plan.ts';
import { describeFailure, toCheckOutcome, toPingResult } from './run-outcomes.ts';
import { splitLines, toUtf16Column, toUtf8ByteColumn } from './text-positions.ts';
import { ProcessSlots, VerseIdeRunner } from './verse-ide-runner.ts';
import { planWatchedFileChanges, toFilePath } from './watch-events.ts';

/** The only argument verse.exe gets. Paths and texts travel in the request on stdin. */
const IDE_REQUEST_ARGUMENTS = ['--ide-request'] as const;

/** A request that looks something up at a position. */
type LookupKind = 'hover' | 'definition';

/** What the server knows about the engine of one tracked folder. */
type FolderEngine =
  | {
    // The engine is being found, allowed and pinged. Analyses wait meanwhile.
    status: 'preparing';

    // Number of this preparation, so that the answer of an older one is ignored.
    preparationId: number;
  }
  | {
    // The folder is analyzed with this engine.
    status: 'ready';

    // The engine.
    location: EngineLocation;
  }
  | {
    // The folder is not analyzed until the local state files change or the analysis is restarted.
    status: 'unusable';
  }
  | {
    // The ping failed in a way that may be temporary. The next trigger prepares the folder again.
    status: 'retryLater';
  };

/** A .verse file that the server may analyze, with the program it belongs to. */
interface AnalyzedFile {
  // Absolute path of the file.
  filePath: string;

  // The folder of the file with "/" separators, which is the program.
  folder: string;
}

/** Connects the parts of the language server for one session, from initialize to exit. */
class VerseServer {
  // The connection to the client.
  private readonly connection: Connection;

  // The documents the client has open, with their current text and version.
  private readonly documents: TextDocuments<TextDocument>;

  // The engineDir setting, which wins over the local state files when it is not empty.
  private readonly configuredEngineDir: string;

  // The workspace folders. Folders inside them keep their diagnostics after their last document closes. The array is
  // shared with the engine registry and changed in place when the client adds or removes a folder.
  private readonly workspaceFolders: string[];

  // Decides when each folder is analyzed.
  private readonly scheduler: CheckScheduler<IdeSuccess>;

  // Finds the engine of each folder, asks for the allowance and pings.
  private readonly registry: EngineRegistry;

  // Watches the folders outside the workspace, where the client's file events do not reach.
  private readonly watcher: FolderWatcher;

  // The slots of all processes of the window, so that the limit holds however many engines are in use.
  private readonly processSlots = new ProcessSlots();

  // One runner per verse.exe, by the comparison key of its path. All of them use the same slots.
  private readonly runners = new Map<string, VerseIdeRunner>();

  // The engine state of every tracked folder, by the comparison key of the folder.
  private readonly folderEngines = new Map<string, FolderEngine>();

  // What was last published for each folder (comparison key of the path to URI string), by folder key.
  private readonly publishedByFolder = new Map<string, ReadonlyMap<string, string>>();

  // Cancels the running analysis of each folder, by folder key.
  private readonly checkAborts = new Map<string, AbortController>();

  // Cancels the running hover or definition of each document, by kind and document URI.
  private readonly lookupAborts = new Map<string, AbortController>();

  // Engine folders that are known, by comparison key. Files inside them are never analyzed.
  private readonly knownEngineDirs = new Map<string, string>();

  // Source of the preparation numbers.
  private preparationCounter = 0;

  // Whether shutdown was requested, after which no new folder is tracked.
  private isShutDown = false;

  /**
   * Creates the parts of the server. Nothing runs until a document is opened.
   *
   * @param connection The connection to the client.
   * @param documents The documents the client has open.
   * @param options What the client sent with the initialize request.
   */
  public constructor(
    connection: Connection,
    documents: TextDocuments<TextDocument>,
    options: Readonly<ServerInitializationOptions>,
  ) {
    this.connection = connection;
    this.documents = documents;
    this.configuredEngineDir = options.configuredEngineDir;
    this.workspaceFolders = [...options.workspaceFolders];

    this.scheduler = new CheckScheduler<IdeSuccess>({
      clock: SYSTEM_CLOCK,
      runner: {
        run: (job) => this.runCheck(job),
        cancel: (folder) => {
          this.checkAborts.get(toComparisonKey(folder))?.abort();
        },
      },
      isInsideWorkspace: (folder) => this.isInsideWorkspace(folder),
      onPublish: (folder, _generation, response) => {
        this.publish(folder, response);
      },
      onCheckResult: (result) => {
        void this.connection.sendNotification(CHECK_RESULT_NOTIFICATION, result);
      },
      onFolderReleased: (folder) => {
        this.forgetFolder(folder);
      },
      log: (message) => {
        this.log(message);
      },
    });

    this.registry = new EngineRegistry({
      configuredEngineDir: this.configuredEngineDir,
      workspaceFolders: this.workspaceFolders,
      findEngine,
      pingRunner: {
        ping: (versePath) => this.ping(versePath),
      },
      client: {
        approveEngine: async (params) => {
          try {
            const isApproved = await this.connection.sendRequest<ApproveEngineResult>(APPROVE_ENGINE_REQUEST, params);
            return (isApproved === true);
          } catch (error) {
            this.log(`Could not ask whether ${params.engineDir} may be used: ${String(error)}`);
            return false;
          }
        },
        notifyUnavailable: (params) => {
          void this.connection.sendNotification(UNAVAILABLE_NOTIFICATION, params);
        },
        log: (message) => {
          this.log(message);
        },
      },
      now: () => Date.now(),
    });

    this.watcher = new FolderWatcher({
      onChange: (folder) => {
        this.handleFolderChange(folder);
      },
      onError: (folder, watcherError) => {
        this.log(`Stopped analyzing ${folder}: watching it for changes failed: ${String(watcherError)}`);
        this.scheduler.releaseFolder(folder);
      },
    });
  }

  /** A document was opened: starts tracking its folder if needed and analyzes the folder at once. */
  public handleOpen(document: TextDocument): void {
    const analyzedFile = this.toAnalyzedFile(document.uri);
    if (this.isShutDown || analyzedFile === undefined || this.isInsideKnownEngine(analyzedFile.filePath)) {
      return;
    }

    const { folder } = analyzedFile;
    const isWatchNeeded = (!this.scheduler.hasFolder(folder) && !this.isInsideWorkspace(folder));
    if (isWatchNeeded && this.watchFolder(folder) !== 'watching') {
      return;
    }

    this.reviveIfRetrying(folder);
    if (!this.scheduler.openDocument(folder, document.uri, document.version)) {
      if (isWatchNeeded) {
        this.watcher.unwatch(folder);
      }
      return;
    }

    if (!this.folderEngines.has(toComparisonKey(folder))) {
      this.startPreparation(folder);
    }
  }

  /** The text of a document changed: analyzes its folder after the debounce time. */
  public handleChange(document: TextDocument): void {
    const analyzedFile = this.toAnalyzedFile(document.uri);
    if (analyzedFile === undefined || !this.scheduler.hasFolder(analyzedFile.folder)) {
      return;
    }

    this.reviveIfRetrying(analyzedFile.folder);
    this.scheduler.changeDocument(analyzedFile.folder, document.uri, document.version);
  }

  /** A document was closed: its folder reads it from disk again, or is let go when it is outside the workspace. */
  public handleClose(document: TextDocument): void {
    for (const lookupKind of ['hover', 'definition'] as const) {
      this.lookupAborts.get(toLookupKey(lookupKind, document.uri))?.abort();
    }

    const analyzedFile = this.toAnalyzedFile(document.uri);
    if (analyzedFile === undefined || !this.scheduler.hasFolder(analyzedFile.folder)) {
      return;
    }

    this.reviveIfRetrying(analyzedFile.folder);
    this.scheduler.closeDocument(analyzedFile.folder, document.uri);

    // The scheduler remembers whether the folder was inside the workspace when it started tracking it. A workspace
    // folder that was removed since then must still be let go here.
    const folder = analyzedFile.folder;
    if (
      this.scheduler.hasFolder(folder) &&
      !this.scheduler.hasOpenDocuments(folder) &&
      !this.isInsideWorkspace(folder)
    ) {
      this.scheduler.releaseFolder(folder);
    }
  }

  /**
   * The client added or removed workspace folders. Folders that are no longer in the workspace are let go when none of
   * their documents is open, and are watched on disk otherwise; folders that are now inside need no watcher of their
   * own. The engines are looked for again, because the local state files that count have changed.
   */
  public handleWorkspaceFoldersChanged(added: readonly string[], removed: readonly string[]): void {
    if (this.isShutDown) {
      return;
    }

    const keptFolders = this.workspaceFolders.filter((workspaceFolder) => {
      return !removed.some((removedFolder) => isSamePath(removedFolder, workspaceFolder));
    });
    for (const addedFolder of added) {
      if (!keptFolders.some((workspaceFolder) => isSamePath(workspaceFolder, addedFolder))) {
        keptFolders.push(addedFolder);
      }
    }
    this.workspaceFolders.splice(0, this.workspaceFolders.length, ...keptFolders);

    for (const folder of this.scheduler.getTrackedFolders()) {
      if (this.isInsideWorkspace(folder)) {
        this.watcher.unwatch(folder);
        continue;
      }

      if (!this.scheduler.hasOpenDocuments(folder)) {
        this.scheduler.releaseFolder(folder);
        continue;
      }

      if (!this.watcher.isWatching(folder) && this.watchFolder(folder) !== 'watching') {
        this.scheduler.releaseFolder(folder);
      }
    }

    this.registry.invalidateAllFolders();
    this.prepareAllAgain();
  }

  /** Files of the workspace changed on disk, as the client's file watcher reports. */
  public handleWatchedFiles(changes: readonly FileEvent[]): void {
    const plan = planWatchedFileChanges(changes, (filePath) => this.findOpenDocument(filePath) !== undefined);
    if (plan.isLocalStateChanged) {
      // A local state file decides the engine of the folders below it, so every folder looks for its engine again.
      this.registry.invalidateAllFolders();
      this.prepareAllAgain();
    }

    for (const folder of plan.changedFolders) {
      this.handleFolderChange(folder);
    }
  }

  /** Answers a hover request with the signature or type of what is under the cursor, or null. */
  public async provideHover(
    params: Readonly<TextDocumentPositionParams>,
    token: CancellationToken,
  ): Promise<Hover | null> {
    const response = await this.lookUp('hover', params, token);
    const hoverResult = response?.hover;
    const filePath = toFilePath(params.textDocument.uri);
    if (hoverResult === undefined || hoverResult === null || filePath === undefined) {
      return null;
    }

    const lines = this.createDocumentTexts().getLines(filePath) ?? [];
    return {
      contents: { kind: MarkupKind.Markdown, value: toVerseCodeBlock(hoverResult.text) },
      range: toLspRange(hoverResult.range, lines),
    };
  }

  /** Answers a definition request with the place of the definition, or null. */
  public async provideDefinition(
    params: Readonly<TextDocumentPositionParams>,
    token: CancellationToken,
  ): Promise<Location | null> {
    const response = await this.lookUp('definition', params, token);
    const definitionResult = response?.definition;
    if (definitionResult === undefined || definitionResult === null) {
      return null;
    }

    // A definition in a file that is neither open nor on disk cannot be shown.
    const lines = this.createDocumentTexts().getLines(definitionResult.path);
    if (lines === undefined) {
      return null;
    }

    const targetDocument = this.findOpenDocument(definitionResult.path);
    return {
      uri: targetDocument?.uri ?? toFileUri(definitionResult.path),
      range: toLspRange(definitionResult.range, lines),
    };
  }

  /** Forgets every engine and every ping result, then prepares and analyzes every tracked folder again. */
  public restartAnalysis(): void {
    if (this.isShutDown) {
      return;
    }

    this.registry.restart();
    this.prepareAllAgain();
  }

  /** Kills every process and stops every watcher. Safe to call more than once. */
  public shutdown(): void {
    if (this.isShutDown) {
      return;
    }

    this.isShutDown = true;
    this.scheduler.shutdown();
    for (const controller of this.lookupAborts.values()) {
      controller.abort();
    }
    this.processSlots.cancelAll();
    this.watcher.unwatchAll();
  }

  /** A .verse file of the folder changed on disk: analyzes the folder after the debounce time, if it is tracked. */
  private handleFolderChange(folder: string): void {
    if (!this.scheduler.hasFolder(folder)) {
      return;
    }

    this.reviveIfRetrying(folder);
    this.scheduler.fileChanged(folder);
  }

  /**
   * Starts watching a folder outside the workspace and returns how that went, after logging why when it failed.
   * Every watched folder has an open document (it is let go when its last one closes), so there is none to let go
   * of to make room.
   */
  private watchFolder(folder: string): WatchResult['status'] {
    const watchResult = this.watcher.watch(folder);
    if (watchResult.status === 'limit') {
      this.log(`Not analyzing ${folder}: ${MAX_WATCHED_FOLDERS} folders outside the workspace are already watched.`);
    }

    if (watchResult.status === 'failed') {
      this.log(`Not analyzing ${folder}: it cannot be watched for changes: ${String(watchResult.watcherError)}`);
    }
    return watchResult.status;
  }

  /** Prepares the folder again when its last ping failed in a way that may be temporary. Call before a trigger. */
  private reviveIfRetrying(folder: string): void {
    if (this.folderEngines.get(toComparisonKey(folder))?.status === 'retryLater') {
      this.startPreparation(folder);
    }
  }

  /** Prepares every tracked folder again and analyzes it once its engine is ready. */
  private prepareAllAgain(): void {
    for (const folder of this.scheduler.getTrackedFolders()) {
      this.startPreparation(folder);
      this.scheduler.fileChanged(folder);
    }
  }

  /** Makes analyses of the folder wait, then finds its engine, asks for the allowance and pings. */
  private startPreparation(folder: string): void {
    this.preparationCounter += 1;
    const preparationId = this.preparationCounter;
    this.folderEngines.set(toComparisonKey(folder), { status: 'preparing', preparationId });
    this.scheduler.setEngineStatus(folder, 'waiting');

    void this.registry.prepareFolder(folder).then(
      (result) => {
        this.finishPreparation(folder, preparationId, result);
      },
      (error: unknown) => {
        this.log(`Preparing ${folder} failed: ${String(error)}`);
        this.finishPreparation(folder, preparationId, { status: 'retryLater' });
      },
    );
  }

  /** Applies the result of a preparation, unless the folder was let go or prepared again in the meantime. */
  private finishPreparation(folder: string, preparationId: number, result: Readonly<PrepareResult>): void {
    const folderKey = toComparisonKey(folder);
    const currentEngine = this.folderEngines.get(folderKey);
    if (currentEngine?.status !== 'preparing' || currentEngine.preparationId !== preparationId) {
      return;
    }

    if (result.status !== 'ready') {
      // Analyses stop, and the diagnostics go, so that running the file shows its errors instead.
      this.folderEngines.set(folderKey, { status: result.status });
      this.clearDiagnostics(folderKey);
      this.scheduler.setEngineStatus(folder, 'unusable');
      return;
    }

    const { location } = result;
    this.knownEngineDirs.set(toComparisonKey(location.engineDir), location.engineDir);
    if (isInsideEngine(folder, location.engineDir)) {
      // The standard library and the other files of the engine are not a program of their own. Its documents are
      // ignored from now on, because the engine is known.
      this.log(`Not analyzing ${folder}: it is inside the engine checkout.`);
      this.scheduler.releaseFolder(folder);
      return;
    }

    this.folderEngines.set(folderKey, { status: 'ready', location });
    this.scheduler.setEngineStatus(folder, 'ready');
  }

  /** Called by the scheduler after it let go of a folder: drops everything else that was kept for it. */
  private forgetFolder(folder: string): void {
    const folderKey = toComparisonKey(folder);
    this.clearDiagnostics(folderKey);
    this.watcher.unwatch(folder);
    this.registry.invalidateFolder(folder);
    this.folderEngines.delete(folderKey);
    this.checkAborts.get(folderKey)?.abort();
    this.checkAborts.delete(folderKey);
  }

  /**
   * Starts the analysis of a folder for the scheduler. The texts of the open documents are read synchronously here,
   * so they are the ones whose versions the scheduler recorded in the job.
   */
  private runCheck(job: Readonly<CheckJob>): Promise<CheckOutcome<IdeSuccess>> {
    const folderKey = toComparisonKey(job.folder);
    const engine = this.folderEngines.get(folderKey);
    if (engine?.status !== 'ready') {
      return Promise.resolve({ isOk: false, error: 'The engine of the folder is not ready.' });
    }

    const request = buildCheckRequest(job.folder, this.collectOverrides(job.folder));
    const controller = new AbortController();
    this.checkAborts.set(folderKey, controller);
    return this.getRunner(engine.location.versePath).run(request, controller.signal).then((outcome) => {
      if (this.checkAborts.get(folderKey) === controller) {
        this.checkAborts.delete(folderKey);
      }
      return toCheckOutcome(outcome);
    });
  }

  /** Pings a verse.exe for the engine registry. */
  private async ping(versePath: string): Promise<PingProcessResult> {
    const outcome = await this.getRunner(versePath).run(buildPingRequest());
    return toPingResult(outcome);
  }

  /**
   * Sends a hover or definition request for the position and returns the answer, or undefined when the folder is not
   * analyzed, the request was cancelled or it failed. A newer request of the same kind for the same document cancels
   * the older one.
   */
  private async lookUp(
    lookupKind: LookupKind,
    params: Readonly<TextDocumentPositionParams>,
    token: CancellationToken,
  ): Promise<IdeSuccess | undefined> {
    const document = this.documents.get(params.textDocument.uri);
    const analyzedFile = this.toAnalyzedFile(params.textDocument.uri);
    if (document === undefined || analyzedFile === undefined || token.isCancellationRequested) {
      return undefined;
    }

    const engine = this.folderEngines.get(toComparisonKey(analyzedFile.folder));
    if (!canLookUp(engine)) {
      return undefined;
    }

    const { line, character } = params.position;
    const lineText = splitLines(document.getText())[line] ?? '';
    const request = buildLookupRequest(
      lookupKind,
      analyzedFile.folder,
      analyzedFile.filePath,
      { line, byte: toUtf8ByteColumn(lineText, character) },
      this.collectOverrides(analyzedFile.folder),
    );

    const lookupKey = toLookupKey(lookupKind, document.uri);
    this.lookupAborts.get(lookupKey)?.abort();
    const controller = new AbortController();
    this.lookupAborts.set(lookupKey, controller);
    const cancellation = token.onCancellationRequested(() => {
      controller.abort();
    });

    const outcome = await this.getRunner(engine.location.versePath).run(request, controller.signal);
    cancellation.dispose();
    if (this.lookupAborts.get(lookupKey) === controller) {
      this.lookupAborts.delete(lookupKey);
    }

    if (outcome.status === 'ok') {
      return outcome.response;
    }

    if (outcome.status !== 'cancelled') {
      this.log(`The ${lookupKind} request for ${analyzedFile.filePath} failed: ${describeFailure(outcome)}`);
    }
    return undefined;
  }

  /** Publishes the diagnostics of an answer, or clears the folder when the analysis failed. */
  private publish(folder: string, response: Readonly<IdeSuccess> | undefined): void {
    const folderKey = toComparisonKey(folder);
    const previous = this.publishedByFolder.get(folderKey) ?? new Map<string, string>();
    if (response === undefined) {
      this.sendPlan(folderKey, planClear(previous));
      return;
    }

    const texts = this.createDocumentTexts();
    const plan = planPublish({
      folder,
      diagnostics: response.diagnostics,
      openDocuments: this.getOpenDocumentInfos(),
      previous,
      getLineText: (filePath, line) => texts.getLineText(filePath, line),
      toUri: toFileUri,
      findFirstFileOnDisk: () => findFirstVerseFile(folder),
    });
    this.sendPlan(folderKey, plan);
  }

  /** Clears every diagnostic that was published for the folder. */
  private clearDiagnostics(folderKey: string): void {
    const previous = this.publishedByFolder.get(folderKey);
    if (previous !== undefined) {
      this.sendPlan(folderKey, planClear(previous));
    }
  }

  /** Sends the notifications of a plan, logs what it could not publish and remembers what is now published. */
  private sendPlan(folderKey: string, plan: Readonly<PublishPlan>): void {
    for (const item of plan.items) {
      void this.connection.sendDiagnostics({ uri: item.uri, diagnostics: item.diagnostics });
    }
    for (const message of plan.logs) {
      this.log(message);
    }

    if (plan.published.size === 0) {
      this.publishedByFolder.delete(folderKey);
      return;
    }
    this.publishedByFolder.set(folderKey, plan.published);
  }

  /** Returns the texts of the open .verse documents of the folder, which verse.exe analyzes instead of the disk. */
  private collectOverrides(folder: string): IdeOverride[] {
    const overrides: IdeOverride[] = [];
    for (const document of this.documents.all()) {
      const analyzedFile = this.toAnalyzedFile(document.uri);
      if (analyzedFile !== undefined && isSamePath(analyzedFile.folder, folder)) {
        overrides.push({ path: analyzedFile.filePath, text: document.getText() });
      }
    }
    return overrides;
  }

  /** Returns the path and URI of every open document that is a file. */
  private getOpenDocumentInfos(): OpenDocumentInfo[] {
    const infos: OpenDocumentInfo[] = [];
    for (const document of this.documents.all()) {
      const filePath = toFilePath(document.uri);
      if (filePath !== undefined) {
        infos.push({ path: filePath, uri: document.uri });
      }
    }
    return infos;
  }

  /** Returns the open document of the file, whatever the spelling of its path, or undefined when it is not open. */
  private findOpenDocument(filePath: string): TextDocument | undefined {
    return this.documents.all().find((document) => {
      const documentPath = toFilePath(document.uri);
      return (documentPath !== undefined && isSamePath(documentPath, filePath));
    });
  }

  /** Creates a text lookup for one answer: open documents by the comparison key of their path, then the disk. */
  private createDocumentTexts(): DocumentTexts {
    const textByKey = new Map<string, string>();
    for (const document of this.documents.all()) {
      const filePath = toFilePath(document.uri);
      if (filePath !== undefined) {
        textByKey.set(toComparisonKey(filePath), document.getText());
      }
    }
    return new DocumentTexts((filePath) => textByKey.get(toComparisonKey(filePath)));
  }

  /** Returns the runner of a verse.exe, creating it on first use. */
  private getRunner(versePath: string): VerseIdeRunner {
    const runnerKey = toComparisonKey(versePath);
    const existingRunner = this.runners.get(runnerKey);
    if (existingRunner !== undefined) {
      return existingRunner;
    }

    const newRunner = new VerseIdeRunner({
      command: versePath,
      args: IDE_REQUEST_ARGUMENTS,
      slots: this.processSlots,
    });
    this.runners.set(runnerKey, newRunner);
    return newRunner;
  }

  /**
   * Returns the file and its program when the URI is a saved .verse file. Documents of other schemes (such as a new
   * file that was never saved) are not analyzed.
   */
  private toAnalyzedFile(uri: string): AnalyzedFile | undefined {
    const filePath = toFilePath(uri);
    if (filePath === undefined || !isVerseFile(filePath)) {
      return undefined;
    }

    const folder = getProgramFolder(filePath);
    return (folder === '' ? undefined : { filePath, folder });
  }

  /** Returns whether the folder is inside one of the workspace folders. */
  private isInsideWorkspace(folder: string): boolean {
    return this.workspaceFolders.some((workspaceFolder) => isInsideFolder(folder, workspaceFolder));
  }

  /** Returns whether the file is inside the configured engine or an engine that some folder uses. */
  private isInsideKnownEngine(filePath: string): boolean {
    if (isInsideEngine(filePath, this.configuredEngineDir)) {
      return true;
    }
    return [...this.knownEngineDirs.values()].some((engineDir) => isInsideEngine(filePath, engineDir));
  }

  /** Writes a line to the client's output channel. */
  private log(message: string): void {
    this.connection.console.log(message);
  }
}

/** Returns the key under which the running lookup of a document is kept. */
function toLookupKey(lookupKind: LookupKind, documentUri: string): string {
  return `${lookupKind} ${documentUri}`;
}

/** Returns the file URI of an absolute path, for a file that the client does not have open. */
function toFileUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

/**
 * Returns the first .verse file of the folder on disk in name order, which is where verse.exe starts too, or undefined
 * when there is none or the folder cannot be read.
 */
function findFirstVerseFile(folder: string): string | undefined {
  let fileNames: string[];
  try {
    fileNames = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isVerseFile(entry.name))
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }

  const [firstName] = fileNames.sort((first, second) => compareLowerCase(first, second));
  if (firstName === undefined) {
    return undefined;
  }
  return (folder.endsWith('/') ? `${folder}${firstName}` : `${folder}/${firstName}`);
}

/** Compares two strings by their lower-case form. */
function compareLowerCase(first: string, second: string): number {
  const firstKey = first.toLowerCase();
  const secondKey = second.toLowerCase();
  if (firstKey === secondKey) {
    return 0;
  }
  return (firstKey < secondKey ? -1 : 1);
}

/**
 * Converts a range of verse.exe (UTF-8 byte offsets) to an LSP range (UTF-16 columns) using the lines of the file.
 * A line that is not available keeps the byte offset as the column.
 */
function toLspRange(ideRange: Readonly<IdeRange>, lines: readonly string[]): Range {
  const toCharacter = (line: number, byte: number): number => {
    const lineText = lines[line];
    return (lineText === undefined ? byte : toUtf16Column(lineText, byte));
  };
  return {
    start: { line: ideRange.start.line, character: toCharacter(ideRange.start.line, ideRange.start.byte) },
    end: { line: ideRange.end.line, character: toCharacter(ideRange.end.line, ideRange.end.byte) },
  };
}

/** Wraps a signature in a Verse code block whose fence is longer than any run of backticks in it. */
function toVerseCodeBlock(text: string): string {
  const backtickRuns = text.match(/`+/g) ?? [];
  const longestRun = Math.max(2, ...backtickRuns.map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}verse\n${text}\n${fence}`;
}

/** Reads the initializationOptions, falling back to no engine setting and no workspace folder for missing values. */
function readInitializationOptions(value: unknown): ServerInitializationOptions {
  const options = (
    typeof value === 'object' && value !== null ?
    (value as Partial<Record<keyof ServerInitializationOptions, unknown>>) :
    {}
  );
  const workspaceFolders = (Array.isArray(options.workspaceFolders) ? (options.workspaceFolders as unknown[]) : []);
  return {
    configuredEngineDir: (typeof options.configuredEngineDir === 'string' ? options.configuredEngineDir : ''),
    workspaceFolders: workspaceFolders.filter((folder): folder is string => typeof folder === 'string'),
  };
}

/** The connection to the client. The transport (IPC) is taken from the command line the client starts us with. */
const clientConnection = createConnection();

/** The documents the client has open. */
const openDocuments = new TextDocuments(TextDocument);

/** The session, which exists from the initialize request on. */
let verseServer: VerseServer | undefined;

/** Whether the client said in the initialize request that it reports added and removed workspace folders. */
let hasWorkspaceFolderEvents = false;

clientConnection.onInitialize((params): InitializeResult => {
  hasWorkspaceFolderEvents = (params.capabilities.workspace?.workspaceFolders === true);
  const options = readInitializationOptions(params.initializationOptions);
  verseServer = new VerseServer(clientConnection, openDocuments, options);
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: TextDocumentSyncKind.Incremental },
      hoverProvider: true,
      definitionProvider: true,
      workspace: {
        // The client sends workspace/didChangeWorkspaceFolders when the user adds or removes a folder.
        workspaceFolders: { supported: true, changeNotifications: true },
      },
    },
  };
});

// The connection creates the workspace folder event only when the initialize request says the client sends it, and
// reading the event before then, or for a client without it, throws and ends the process. So the handler is added
// once initialization is done, and only for a client that sends the event.
clientConnection.onInitialized(() => {
  if (!hasWorkspaceFolderEvents) {
    return;
  }

  clientConnection.workspace.onDidChangeWorkspaceFolders((event) => {
    const toPaths = (folders: readonly WorkspaceFolder[]): string[] => {
      return folders
        .map((workspaceFolder) => toFilePath(workspaceFolder.uri))
        .filter((folderPath): folderPath is string => folderPath !== undefined);
    };
    verseServer?.handleWorkspaceFoldersChanged(toPaths(event.added), toPaths(event.removed));
  });
});

openDocuments.onDidOpen((event) => {
  verseServer?.handleOpen(event.document);
});

openDocuments.onDidChangeContent((event) => {
  verseServer?.handleChange(event.document);
});

openDocuments.onDidClose((event) => {
  verseServer?.handleClose(event.document);
});

clientConnection.onDidChangeWatchedFiles((params) => {
  verseServer?.handleWatchedFiles(params.changes);
});

clientConnection.onHover((params, token) => verseServer?.provideHover(params, token) ?? null);

clientConnection.onDefinition((params, token) => verseServer?.provideDefinition(params, token) ?? null);

clientConnection.onRequest(RESTART_ANALYSIS_REQUEST, () => {
  verseServer?.restartAnalysis();
});

clientConnection.onShutdown(() => {
  verseServer?.shutdown();
});

clientConnection.onExit(() => {
  verseServer?.shutdown();
});

openDocuments.listen(clientConnection);
clientConnection.listen();
