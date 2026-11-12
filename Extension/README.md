# Verse Playground for VS Code

Runs, debugs and edits single Verse programs with the `verse.exe` that
[VersePlayground](https://github.com/Naotsun19B/VersePlayground) builds from Unreal Engine 6.

## Features

- **Run**: the ▶ button in the editor title runs the open `.verse` file in a terminal, so `InputLine` can read
  what you type. Compiler errors appear in the Problems panel (from the language server when it runs, otherwise from
  the run). "Verse: Run Verse File with Arguments..." passes arguments to `Main` in `Args`.
- **Debug**: the debug button next to it, or F5, stops at breakpoints and shows the call stack and local variables.
  Step over, step into, step out and continue work. One Verse debugging session can run at a time.
- **Syntax highlighting**: copied from your own engine checkout the first time the extension starts. Reload the
  window when it asks.
- **Errors while you type, hover, go to definition and completion**: the extension starts the Verse language server
  that comes with the Verse extension UEFN installs into VS Code. Without UEFN, everything else still works.

## Requirements

Run `Setup.bat` from VersePlayground first. The extension finds the engine through `VersePlayground.local.json` in
the folder you open or one of its parents, or through the `versePlayground.engineDir` setting.

If the UEFN Verse extension (`epicgames.verse`) is enabled, disable it for the workspace. Otherwise both language
servers run and every error is shown twice. Verse Playground uses that extension's language server even while it is
disabled.

## Settings

| Setting | Meaning |
|---|---|
| `versePlayground.engineDir` | Engine folder that `Setup.bat` created. Empty reads `VersePlayground.local.json`. |
| `versePlayground.languageServer.enabled` | Start the language server. |
| `versePlayground.languageServer.path` | Path to `verse-lsp.exe`. Empty uses the one in the UEFN Verse extension. |

## License

Verse Playground is released under the MIT License (see `LICENSE`).

The extension contains no Epic Games code. The Verse grammar and the language server stay in your own engine
checkout and UEFN installation and are never packaged with it. The licenses of the npm packages bundled into the
extension are in `dist/ThirdPartyNotices.txt` inside the package.
