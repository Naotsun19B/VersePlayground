// Copyright (c) 2026 Naotsun

import type * as vscode from 'vscode';

import { toEngineLocation } from './shared/engine-locator.ts';
import { isInsideFolder, toComparisonKey } from './shared/program-paths.ts';
import type { ApproveEngineParams, EngineSource } from './shared/protocol-types.ts';

/** Key in the extension's global state that holds the comparison keys of the engines the user allowed. */
const ALLOWED_ENGINES_KEY = 'versePlayground.allowedEngines';

/** Label of the confirmation button that allows the engine. */
const ALLOW_LABEL = 'Allow';

/** Label of the confirmation button that refuses the engine. */
const DENY_LABEL = 'Don\'t Allow';

/** Which settings level the engineDir value comes from. */
export type SettingScope = 'user' | 'workspace' | 'none';

/** What to do with a request to run an engine's verse.exe. */
export type ApprovalDecision = 'allow' | 'deny' | 'ask';

/** Everything the decision looks at. */
export interface ApprovalInput {
  /** Comparison key of the engine folder; the unit that approvals are remembered for. */
  engineKey: string;

  /** Where the engine was found. */
  source: EngineSource;

  /** Settings level of the engineDir value. Only meaningful when the engine came from the setting. */
  settingScope: SettingScope;

  /** Folders of the trusted workspace. Empty when the workspace is not trusted. */
  trustedFolders: readonly string[];

  /** Comparison keys of the engines the user allowed for good. */
  approvedGlobally: ReadonlySet<string>;

  /** Comparison keys of the engines already used in this window through a route that needs no confirmation. */
  usedInWindow: ReadonlySet<string>;

  /** Comparison keys of the engines the user refused in this window. */
  deniedInWindow: ReadonlySet<string>;
}

/**
 * Returns whether the way the engine was found is trusted by itself: the user's own settings, or a local state file
 * inside a trusted workspace folder. A workspace setting or a file outside the workspace could have been planted.
 */
export function isConfirmationFreeRoute(
  source: Readonly<EngineSource>,
  settingScope: SettingScope,
  trustedFolders: readonly string[],
): boolean {
  if (source.kind === 'setting') {
    return settingScope === 'user';
  }
  return trustedFolders.some((trustedFolder) => isInsideFolder(source.stateFilePath, trustedFolder));
}

/**
 * Decides whether the engine's verse.exe may be run. A route that needs no confirmation always allows, even after the
 * user refused the engine elsewhere, so trusted workspace folders are never blocked. Otherwise an earlier allowance
 * wins, then an earlier refusal in this window, and the rest is asked.
 */
export function decideApproval(input: Readonly<ApprovalInput>): ApprovalDecision {
  if (isConfirmationFreeRoute(input.source, input.settingScope, input.trustedFolders)) {
    return 'allow';
  }

  if (input.approvedGlobally.has(input.engineKey) || input.usedInWindow.has(input.engineKey)) {
    return 'allow';
  }

  if (input.deniedInWindow.has(input.engineKey)) {
    return 'deny';
  }
  return 'ask';
}

/** The parts of VS Code that the approval needs, so that the logic can run without it. */
export interface ApprovalHost {
  /** Returns which settings level the engineDir value comes from. */
  getEngineDirSettingScope(): SettingScope;

  /** Returns the workspace folders, or an empty array when the workspace is not trusted. */
  getTrustedFolders(): readonly string[];

  /** Reads the comparison keys of the engines allowed for good. */
  readAllowedEngines(): readonly string[];

  /** Replaces the comparison keys of the engines allowed for good. */
  writeAllowedEngines(engineKeys: readonly string[]): Promise<void>;

  /**
   * Shows a non-modal warning with the buttons. Resolves to the clicked label, or undefined when it was closed.
   * The promise may stay unresolved for a long time when the notification is hidden in the notification center.
   */
  showConfirmation(message: string, buttons: readonly string[]): Promise<string | undefined>;
}

/**
 * Remembers which engines may be run and asks the user when the way an engine was found is not trusted by itself.
 *
 * One instance lives for the window, so that refusals survive the language server being recreated.
 */
export class EngineApproval {
  // Engines used in this window through a route that needs no confirmation. The same exe is not asked about again.
  private readonly usedInWindow = new Set<string>();

  // Engines the user refused in this window. They are not remembered across windows.
  private readonly deniedInWindow = new Set<string>();

  // Confirmations waiting for an answer by engine, so that folders asking about one engine share one notification.
  private readonly pendingAnswers = new Map<string, Promise<boolean>>();

  // The parts of VS Code this object talks to.
  private readonly host: ApprovalHost;

  /** @param host The parts of VS Code that the approval needs. */
  constructor(host: ApprovalHost) {
    this.host = host;
  }

  /**
   * Answers the approveEngine request: may the engine's verse.exe be run to analyze the folder?
   * Asks the user at most once per engine at a time.
   */
  async approve(params: Readonly<ApproveEngineParams>): Promise<boolean> {
    const engineKey = toComparisonKey(params.engineDir);
    const trustedFolders = this.host.getTrustedFolders();
    const settingScope = this.host.getEngineDirSettingScope();
    const decision = decideApproval({
      engineKey,
      source: params.source,
      settingScope,
      trustedFolders,
      approvedGlobally: new Set(this.host.readAllowedEngines()),
      usedInWindow: this.usedInWindow,
      deniedInWindow: this.deniedInWindow,
    });

    if (decision === 'allow') {
      if (isConfirmationFreeRoute(params.source, settingScope, trustedFolders)) {
        this.usedInWindow.add(engineKey);
      }
      return true;
    }

    if (decision === 'deny') {
      return false;
    }

    const pendingAnswer = this.pendingAnswers.get(engineKey);
    if (pendingAnswer !== undefined) {
      return pendingAnswer;
    }

    const newAnswer = this.ask(engineKey, params);
    this.pendingAnswers.set(engineKey, newAnswer);
    try {
      return await newAnswer;
    } finally {
      this.pendingAnswers.delete(engineKey);
    }
  }

  /** Forgets the refusals of this window, so that the next use asks again. Allowances are kept. */
  forgetDenials(): void {
    this.deniedInWindow.clear();
  }

  /** Forgets every remembered allowance, and the engines used in this window, so that the next use asks again. */
  async forgetAllowedEngines(): Promise<void> {
    this.usedInWindow.clear();
    await this.host.writeAllowedEngines([]);
  }

  /** Asks the user, then records the answer. Closing the notification counts as a refusal. */
  private async ask(engineKey: string, params: Readonly<ApproveEngineParams>): Promise<boolean> {
    const versePath = toEngineLocation(params.engineDir).versePath;
    const answer = await this.host.showConfirmation(
      `Verse Playground wants to run ${versePath} to check ${params.folder} for errors. ` +
      'Allow it only if you trust this engine folder.',
      [ALLOW_LABEL, DENY_LABEL],
    );

    if (answer === ALLOW_LABEL) {
      const allowedEngines = this.host.readAllowedEngines();
      if (!allowedEngines.includes(engineKey)) {
        await this.host.writeAllowedEngines([...allowedEngines, engineKey]);
      }
      return true;
    }

    this.deniedInWindow.add(engineKey);
    return false;
  }
}

/**
 * Connects the approval to VS Code.
 *
 * @param vscodeApi The vscode module, passed in so that this file can be loaded without it.
 * @param globalState The extension's global state, which remembers allowed engines.
 */
export function createVscodeApprovalHost(vscodeApi: typeof vscode, globalState: vscode.Memento): ApprovalHost {
  return {
    getEngineDirSettingScope: () => {
      const inspected = vscodeApi.workspace.getConfiguration('versePlayground').inspect<string>('engineDir');
      if (inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined) {
        return 'workspace';
      }
      return (inspected?.globalValue !== undefined ? 'user' : 'none');
    },
    getTrustedFolders: () => {
      if (!vscodeApi.workspace.isTrusted) {
        return [];
      }
      return (vscodeApi.workspace.workspaceFolders ?? []).map((workspaceFolder) => workspaceFolder.uri.fsPath);
    },
    readAllowedEngines: () => globalState.get<string[]>(ALLOWED_ENGINES_KEY, []),
    writeAllowedEngines: async (engineKeys) => {
      await globalState.update(ALLOWED_ENGINES_KEY, [...engineKeys]);
    },
    showConfirmation: async (message, buttons) => {
      return vscodeApi.window.showWarningMessage(message, ...buttons);
    },
  };
}
