// Copyright (c) 2026 Naotsun

/** What the server knows about the engine of one tracked folder, reduced to the state name. */
export type FolderEngineStatus = 'preparing' | 'ready' | 'unusable' | 'retryLater';

/**
 * Returns whether a hover or definition request may run verse.exe for a folder.
 *
 * Only a folder whose engine is found, allowed and pinged is looked up. A folder that is still being prepared (for
 * example while the user is asked for the allowance), a folder whose engine is not allowed or unusable, a folder whose
 * last ping failed temporarily and a folder the server does not know yet all answer nothing.
 *
 * @param engine The engine state of the folder, or undefined when the server has none for it.
 */
export function canLookUp<TEngine extends Readonly<{ status: FolderEngineStatus }>>(
  engine: TEngine | undefined,
): engine is Extract<TEngine, { status: 'ready' }> {
  return (engine?.status === 'ready');
}
