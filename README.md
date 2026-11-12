# VersePlayground

English | [日本語](README.ja.md)

A playground for trying Verse in Unreal Engine 6 without UEFN and without building the whole engine.

`Setup.bat` fetches only the parts of the Unreal Engine repository that Verse needs and builds `verse.exe`,
the Verse command-line tool. After that, you can write a single `.verse` file and run it right away to see what it does.

This repository contains no Epic Games code or binaries.
Setup fetches the engine source from the Epic Games repository on GitHub with your own access.

<video src="https://github.com/user-attachments/assets/bb90121e-1ba5-4899-ac6e-d9106fdf8728" autoplay loop muted playsinline controls width="100%"></video>

## Requirements

| Item | Details |
|---|---|
| Access to the Unreal Engine source | Link your GitHub account to your Epic Games account so that you can see `EpicGames/UnrealEngine` ([instructions](https://www.unrealengine.com/ue-on-github)) |
| Git for Windows | 2.27 or later |
| Visual Studio | Visual Studio 2026 or Visual Studio 2026 Build Tools with the MSVC toolchain the engine needs (v14.50, 14.50.35723 or later, for the current version). The engine compiles with its bundled Clang and uses the MSVC libraries. Older Visual Studio products are ignored by the build. When it is missing, Setup offers to add it with the Visual Studio Installer |
| Windows SDK | The version the engine needs (10.0.26100.0 or later for the current version). When it is missing, Setup offers to add it with the Visual Studio Installer |
| Disk | About 10 GB (about 5 GB of fetched and extracted files, 2.5 GB of intermediate build files, and 1 GB of download cache) |
| Memory | 16 GB or more is recommended. Setup chooses the number of parallel compile processes from the installed memory |

Setup downloads about 230 MB with git and about 1 GB of binary dependencies. Fetching the whole engine takes tens of GB.

## Usage

1. Clone this repository.
2. Double-click `Setup.bat`.
3. Choose a version. Pressing Enter picks the newest verified version.
   If that version needs a Windows SDK or an MSVC toolchain you do not have, Setup says so before downloading
   anything and offers to install them. It adds them to Visual Studio 2026, or installs Visual Studio 2026 Build
   Tools next to your other Visual Studio products when there is none. Windows asks for administrator permission,
   and Visual Studio must be closed while it installs. `-InstallBuildTools Yes` or `-InstallBuildTools No` answers
   without asking.
4. The first time, Git asks you to sign in to GitHub. Sign in with the account that has access to the Unreal Engine
   repository.
5. When fetching and building finish, Setup runs `Samples/HelloWorld/HelloWorld.verse` and prints `Hello, World!`.
6. If VS Code is installed, Setup asks whether to install the Verse Playground extension (see [VS Code](#vs-code)).
   `-InstallExtension Yes` or `-InstallExtension No` answers without asking.

The engine goes to `UnrealEngine/` by default. Use `-InstallDir` to put it somewhere else.

```bat
Setup.bat -InstallDir D:\VerseEngine
```

Running `Setup.bat` again switches the same folder to the chosen version and rebuilds it.

## Running Verse

```bat
UnrealEngine\Engine\Binaries\Win64\verse.exe Samples\HelloWorld\HelloWorld.verse
UnrealEngine\Engine\Binaries\Win64\verse.exe Samples\HelloWorld\HelloWorld.verse Verse
```

`verse.exe` calls `Main` in the file. Arguments after the script path are passed in `Args`.

```verse
Main(Args:[]string, Env:[string]string)<suspends>:void =
    Print("Hello, World!")
```

Compile errors are printed as `file(line,column,line,column): Verse compiler error V3506: ...`.

### Samples

Each sample is a folder with one program in it. Keep to one program per folder for your own code too: the VS Code
language server checks all files in a folder together, so two `Main` functions in one folder conflict.

| File | Shows |
|---|---|
| `Samples/HelloWorld/HelloWorld.verse` | The smallest program, and reading command-line arguments |
| `Samples/Greeting/Greeting.verse` | Reading your name from standard input with `InputLine` and greeting you |
| `Samples/FailureContext/FailureContext.verse` | Expressions that can fail, failure contexts, and `<decides>` functions |
| `Samples/Concurrency/Concurrency.verse` | Structured concurrency with `race` and `sync` |
| `Samples/Modules/Modules.verse` | Modules, access specifiers, abstract classes and inheritance, and effects |

### What is available

- You can use the `/Verse.org/Verse` standard library and the input/output functions that `verse.exe` provides.
  - `Print`, `InputLine` (standard input), `LoadTextFile` / `SaveTextFile`, `Yield`, `Exit`
- Fortnite and UEFN APIs (`/Fortnite.com/...`, `Sleep`, and so on) are not available. Code from UEFN tutorials may
  not run as is.
- `verse.exe` has a `--mount` option for loading modules from other folders, but it is not implemented yet.
  Define modules in the same file as `Main`.

## VS Code

`Extension/verse-playground.vsix` is a VS Code extension for this playground. Setup offers to install it, or install
it yourself with "Extensions: Install from VSIX..." in VS Code. Open this repository's folder (or any folder below it)
and the extension finds `verse.exe` by itself.

| Feature | Details |
|---|---|
| Run | The ▶ button in the editor title, or Ctrl+F5, runs the open file in a terminal, so `InputLine` works. To change the key, search for "Verse: Run Verse File" in Keyboard Shortcuts (Ctrl+K Ctrl+S) |
| Arguments | Ctrl+Shift+F5 ("Verse: Run Verse File with Arguments...") or Shift+F5 ("Verse: Debug Verse File with Arguments...") asks for the arguments passed in `Args`. Each `.verse` file remembers the arguments used with it; pick one with the up and down keys, newest first |
| Debug | The button next to it, or F5. Breakpoints, step over / into / out, the call stack, and local variables in the Variables view. A breakpoint on a line that calls a Verse function stops again when the call returns |
| Syntax highlighting | Copied from your engine checkout the first time the extension starts. Reload the window when it asks |
| Errors | Compile errors from running a file appear in the Problems panel |
| Errors while typing, hover, go to definition, completion | Needs the Verse language server, see below |

The language server is not part of this repository or of the Unreal Engine source. It comes with the Verse extension
(`epicgames.verse`) that UEFN installs into VS Code, which is not on the VS Code Marketplace. If you have UEFN, Verse
Playground uses that server with the Verse version of your engine checkout. Disable the UEFN Verse extension for the
workspace, or both servers run and every error is shown twice; Verse Playground tells you when it is enabled. Without
UEFN, everything else in the table still works.

## Versions

`Versions/` holds, for each engine commit, the list of directories to fetch and the list of binary dependencies.

| File | Contents |
|---|---|
| `sparse-paths.txt` | Directories that git fetches with sparse checkout |
| `gitdepsignore.txt` | Whitelist of binary dependencies for the engine's `GitDependencies`. Setup copies it to `.gitdepsignore` |
| `version.json` | The commit, whether it has been verified, the estimated download size, and the Windows SDK and MSVC toolchain the engine needs |

Setup defaults to a verified version (`"verified": true`) and warns when you choose one that has not been verified.
Pass a folder name or the start of a commit hash to `-Version` to use that version without being asked.

### Adding a new engine commit (for maintainers)

1. Clone the full engine and run the engine's `Setup.bat`.
2. Generate the lists.

   ```powershell
   .\Tools\New-VersionManifest.ps1 -EngineDir 'D:\UnrealEngine'
   ```

   This exports the module dependencies of the `VerseCmd` target with UnrealBuildTool, adds the rules in
   `Tools/ManifestRules.psd1`, and creates `Versions/<branch>-<commit>/`.
3. Run Setup into an empty folder to check it.

   ```bat
   Setup.bat -Version <folder name> -InstallDir D:\VerseVerify
   ```

4. When the build and the samples succeed, set `verified` to `true` and `verifiedDate` to the date of the check in
   `version.json`.

Files that the module dependencies do not cover, such as files that UnrealBuildTool reads directly and the bundled
compiler, are listed in `Tools/ManifestRules.psd1` together with the reason for each. When a new commit fails to
build, first check whether something needs to be added there.

### Building the VS Code extension (for maintainers)

The extension's source is in `Extension/`. Building it needs Node.js 22.18 or later.

```bat
cd Extension
npm ci
npm run package
```

This type-checks, runs the tests and writes `Extension/verse-playground.vsix`. Raise `version` in
`Extension/package.json` and commit the new `.vsix` so that users need no Node.js and can tell which build they have.

To try a change without packaging, open the `Extension` folder in VS Code and press F5 ("Run Extension"). It builds
the extension and opens the repository root in a second window, the Extension Development Host, that loads the
extension from source instead of the installed one. Breakpoints in `Extension/src` stop there. `npm test` runs only
the unit tests in `Extension/test`.

## License

The scripts, tools and VS Code extension in this repository are released under the [MIT License](LICENSE).

The programs in `Samples/` are for learning. Copy, modify and reuse them freely, without keeping any notice.

The Unreal Engine source and binaries that Setup fetches are not part of this repository. They stay under the Unreal
Engine EULA that you accepted to get access to them.
