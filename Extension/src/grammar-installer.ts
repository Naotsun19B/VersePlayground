// Copyright (c) 2026 Naotsun

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EngineLocation } from './engine-locator.ts';

/**
 * Result of {@link installGrammar}.
 * - `installed`: files were copied or changed, so VS Code must reload the window to pick them up.
 * - `unchanged`: the extension already has the engine's files.
 * - `missing`: the engine checkout does not contain the grammar.
 */
export type GrammarInstallResult = 'installed' | 'unchanged' | 'missing';

/** Folder inside the extension that package.json points the grammar and language configuration at. */
const SYNTAXES_FOLDER_NAME = 'syntaxes';

/** File name of the grammar, both in the engine and in the extension. */
const GRAMMAR_FILE_NAME = 'verse.tmLanguage.json';

/** File name of the language configuration in the extension. */
const LANGUAGE_CONFIGURATION_FILE_NAME = 'verse-language-configuration.json';

/**
 * Copies the Verse grammar and language configuration from the engine checkout into the extension.
 *
 * VS Code reads grammars only from paths declared in package.json, inside the extension. The .vsix does not contain
 * these files so that it never redistributes Epic Games files; each user gets them from their own engine checkout.
 * Reinstalling the extension removes the copies, and the next activation copies them again.
 */
export function installGrammar(engine: EngineLocation, extensionPath: string): GrammarInstallResult {
  const sourceGrammarPath = path.join(engine.grammarDir, GRAMMAR_FILE_NAME);
  if (!fs.existsSync(sourceGrammarPath) || !fs.existsSync(engine.languageConfigurationPath)) {
    return 'missing';
  }

  const syntaxesDir = path.join(extensionPath, SYNTAXES_FOLDER_NAME);
  fs.mkdirSync(syntaxesDir, { recursive: true });
  const hasCopiedGrammar = copyIfChanged(sourceGrammarPath, path.join(syntaxesDir, GRAMMAR_FILE_NAME));
  const hasCopiedConfiguration = copyIfChanged(
    engine.languageConfigurationPath,
    path.join(syntaxesDir, LANGUAGE_CONFIGURATION_FILE_NAME),
  );
  return ((hasCopiedGrammar || hasCopiedConfiguration) ? 'installed' : 'unchanged');
}

/** Copies the file unless the destination already has the same bytes. Returns true when it copied. */
function copyIfChanged(sourcePath: string, destinationPath: string): boolean {
  const sourceBytes = fs.readFileSync(sourcePath);
  if (fs.existsSync(destinationPath) && fs.readFileSync(destinationPath).equals(sourceBytes)) {
    return false;
  }
  fs.writeFileSync(destinationPath, sourceBytes);
  return true;
}
