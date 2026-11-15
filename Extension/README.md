# Verse Playground for VS Code

Runs, debugs and edits single Verse programs with the `verse.exe` that
[VersePlayground](https://github.com/Naotsun19B/VersePlayground) builds from Unreal Engine 6.

## Features

- **Run**: the ▶ button in the editor title, or Ctrl+F5, runs the open `.verse` file in a terminal, so `InputLine`
  can read what you type. Compiler errors appear in the Problems panel (from the language server when it runs,
  otherwise from the run). To use another key, search for "Verse: Run Verse File" in Keyboard Shortcuts
  (Ctrl+K Ctrl+S) and change it.
- **Arguments**: Ctrl+Shift+F5 ("Verse: Run Verse File with Arguments...") or Shift+F5 ("Verse: Debug Verse File
  with Arguments...") asks for the arguments passed to `Main` in `Args`. The arguments you used are remembered for each
  `.verse` file: pick one with the up and down keys (newest first), press the pencil to edit it, or type a new line.
- **Debug**: the debug button next to it, or F5, stops at breakpoints and shows the call stack and the local
  variables in the Variables view, with structs and arrays expanded. Step over, step into, step out and continue
  work. One Verse debugging session can run at a time. A breakpoint on a line that calls a Verse function stops
  again when the call returns; press Continue once more to go on.
- **Syntax highlighting**: copied from your own engine checkout the first time the extension starts. Reload the
  window when it asks.
- **One folder, one program**: running, debugging and the editor checks compile every `.verse` file directly in the
  folder as one program, so a function in another file of the folder can be used, and two `Main` functions in one
  folder conflict. Unsaved `.verse` files of the folder are saved before a run.
- **Errors while you type, hover and go to definition**: the extension analyzes the folder with the `verse.exe` that
  Setup built, so the errors match a run and UEFN is not needed. Hover and go to definition work on a place that uses
  a definition, and return nothing while the folder has a syntax error. With the UEFN language server (see
  `versePlayground.languageServer.kind`) you also get completion.

## Requirements

Run `Setup.bat` from VersePlayground first. The extension finds the engine through `VersePlayground.local.json` in
the folder you open or one of its parents, or through the `versePlayground.engineDir` setting.

The built-in analysis needs a `verse.exe` built with the `verse-ide-analysis` engine patch, which Setup applies for
`ue6-main-f9f48a4bf1b9` and `ue6-main-7dc0dff55638`. When your `verse.exe` does not have it, the extension says so;
run `Setup.bat` again with one of those versions, then "Verse: Restart Language Server".

If the UEFN Verse extension (`epicgames.verse`) is enabled, disable it for the workspace. Otherwise both language
servers would run and every error would be shown twice, so Verse Playground does not start its own.

The extension is disabled in an untrusted workspace (Restricted Mode), because it starts `verse.exe`. For an engine
found from a file opened without a folder, a file outside the workspace, or the workspace settings, a notification
asks once whether that `verse.exe` may run. "Verse: Forget Allowed Engines" clears what you allowed.

## Settings

| Setting | Meaning |
|---|---|
| `versePlayground.engineDir` | Engine folder that `Setup.bat` created. Empty reads `VersePlayground.local.json`. |
| `versePlayground.languageServer.enabled` | Start the language server. |
| `versePlayground.languageServer.kind` | `builtin` (default) analyzes with `verse.exe`. `uefn` uses the language server that UEFN ships, which also gives completion. |
| `versePlayground.languageServer.path` | Path to `verse-lsp.exe`. Used only when `kind` is `uefn`. Empty uses the one in the UEFN Verse extension. |

## License

Verse Playground is released under the MIT License (see `LICENSE`).

The extension contains no Epic Games code. The Verse grammar, `verse.exe` and the UEFN language server stay in your
own engine checkout and UEFN installation and are never packaged with it. The licenses of the npm packages bundled into the
extension are in `dist/ThirdPartyNotices.txt` inside the package.
