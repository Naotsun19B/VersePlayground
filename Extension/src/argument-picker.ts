// Copyright (c) 2026 Naotsun

import * as vscode from 'vscode';

import type { ArgumentHistory } from './argument-history.ts';
import { getArgumentLines, recordArgumentLine } from './argument-history.ts';

/** Workspace state key of the argument history, shared by running and debugging. */
const ARGUMENT_HISTORY_KEY = 'versePlayground.argumentHistory';

/** One entry of the picker: an argument line to use, shown with a label the user can recognize. */
interface ArgumentItem extends vscode.QuickPickItem {
  /** The line to split into arguments when this entry is chosen. */
  argumentLine: string;
}

/** Button on a history entry that copies its line into the input box, so it can be changed before use. */
const EDIT_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('edit'),
  tooltip: 'Edit these arguments',
};

/**
 * Asks for the arguments to pass to Main, offering the lines used with the same file before, newest first.
 *
 * Like a console's command history, the up and down keys walk from the newest line to the oldest, and Enter uses
 * the highlighted one. Typing narrows the history and also offers the typed text itself as new arguments. The chosen
 * line moves to the front of the file's history.
 *
 * @returns The chosen argument line, or undefined when the user cancelled.
 */
export async function pickArgumentLine(
  context: vscode.ExtensionContext,
  filePath: string,
  title: string,
): Promise<string | undefined> {
  const history = context.workspaceState.get<ArgumentHistory>(ARGUMENT_HISTORY_KEY, {});
  const historyItems = getArgumentLines(history, filePath).map((argumentLine): ArgumentItem => ({
    label: argumentLine,
    argumentLine,
    buttons: [EDIT_BUTTON],
  }));

  const quickPick = vscode.window.createQuickPick<ArgumentItem>();
  quickPick.title = title;
  quickPick.placeholder = (
    historyItems.length > 0 ?
    'Type new arguments, or pick earlier ones with the up and down keys. Use double quotes for spaces.' :
    'Arguments passed to Main in Args, after the script path. Use double quotes for spaces.'
  );
  quickPick.ignoreFocusOut = true;
  quickPick.items = buildItems('', historyItems);
  quickPick.onDidChangeValue((typedValue) => {
    quickPick.items = buildItems(typedValue, historyItems);
  });
  quickPick.onDidTriggerItemButton((buttonEvent) => {
    quickPick.value = buttonEvent.item.argumentLine;
  });

  const chosenLine = await new Promise<string | undefined>((resolve) => {
    quickPick.onDidAccept(() => {
      const chosenItem = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
      resolve(chosenItem?.argumentLine ?? quickPick.value);
      quickPick.hide();
    });
    quickPick.onDidHide(() => resolve(undefined));
    quickPick.show();
  });
  quickPick.dispose();

  if (chosenLine !== undefined) {
    await context.workspaceState.update(ARGUMENT_HISTORY_KEY, recordArgumentLine(history, filePath, chosenLine));
  }
  return chosenLine;
}

/**
 * Returns the entries to show for the typed text: the text itself as new arguments when it is not in the history,
 * followed by the history. With nothing typed and no history, a single entry runs without arguments.
 */
function buildItems(typedValue: string, historyItems: readonly ArgumentItem[]): ArgumentItem[] {
  if (typedValue.length === 0) {
    if (historyItems.length > 0) {
      return [...historyItems];
    }
    return [{ label: '(no arguments)', argumentLine: '', alwaysShow: true }];
  }

  if (historyItems.some((historyItem) => historyItem.argumentLine === typedValue)) {
    return [...historyItems];
  }
  const typedItem: ArgumentItem = {
    label: typedValue,
    description: 'new arguments',
    argumentLine: typedValue,
    alwaysShow: true,
  };
  return [typedItem, ...historyItems];
}
