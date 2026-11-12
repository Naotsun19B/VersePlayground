# VersePlayground

English | [日本語](README.ja.md)

A playground for trying Verse in Unreal Engine 6 without UEFN and without building the whole engine.

`Setup.bat` fetches only the parts of the Unreal Engine repository that Verse needs and builds `verse.exe`,
the Verse command-line tool. After that, you can write a single `.verse` file and run it right away to see what it does.

This repository contains no Epic Games code or binaries.
Setup fetches the engine source from the Epic Games repository on GitHub with your own access.

## Requirements

| Item | Details |
|---|---|
| Access to the Unreal Engine source | Link your GitHub account to your Epic Games account so that you can see `EpicGames/UnrealEngine` ([instructions](https://www.unrealengine.com/ue-on-github)) |
| Git for Windows | 2.27 or later |
| Visual Studio | The "Desktop development with C++" workload and a Windows 10/11 SDK. The build uses the compiler bundled with the engine |
| Disk | About 10 GB (about 5 GB of fetched and extracted files, 2.5 GB of intermediate build files, and 1 GB of download cache) |
| Memory | 16 GB or more is recommended. Setup chooses the number of parallel compile processes from the installed memory |

Setup downloads about 230 MB with git and about 1 GB of binary dependencies. Fetching the whole engine takes tens of GB.

## Usage

1. Clone this repository.
2. Double-click `Setup.bat`.
3. Choose a version. Pressing Enter picks the newest verified version.
4. The first time, Git asks you to sign in to GitHub. Sign in with the account that has access to the Unreal Engine
   repository.
5. When fetching and building finish, Setup runs `Samples/HelloWorld.verse` and prints `Hello, World!`.

The engine goes to `UnrealEngine/` by default. Use `-InstallDir` to put it somewhere else.

```bat
Setup.bat -InstallDir D:\VerseEngine
```

Running `Setup.bat` again switches the same folder to the chosen version and rebuilds it.

## Running Verse

```bat
UnrealEngine\Engine\Binaries\Win64\verse.exe Samples\HelloWorld.verse
UnrealEngine\Engine\Binaries\Win64\verse.exe Samples\HelloWorld.verse Verse
```

`verse.exe` calls `Main` in the file. Arguments after the script path are passed in `Args`.

```verse
Main(Args:[]string, Env:[string]string)<suspends>:void =
    Print("Hello, World!")
```

Compile errors are printed as `file(line,column,line,column): Verse compiler error V3506: ...`.

### Samples

| File | Shows |
|---|---|
| `Samples/HelloWorld.verse` | The smallest program, and reading command-line arguments |
| `Samples/FailureContext.verse` | Expressions that can fail, failure contexts, and `<decides>` functions |
| `Samples/Concurrency.verse` | Structured concurrency with `race` and `sync` |
| `Samples/Modules.verse` | Modules, access specifiers, abstract classes and inheritance, and effects |

### What is available

- You can use the `/Verse.org/Verse` standard library and the input/output functions that `verse.exe` provides.
  - `Print`, `InputLine` (standard input), `LoadTextFile` / `SaveTextFile`, `Yield`, `Exit`
- Fortnite and UEFN APIs (`/Fortnite.com/...`, `Sleep`, and so on) are not available. Code from UEFN tutorials may
  not run as is.
- `verse.exe` has a `--mount` option for loading modules from other folders, but it is not implemented yet.
  Define modules in the same file as `Main`.

## Versions

`Versions/` holds, for each engine commit, the list of directories to fetch and the list of binary dependencies.

| File | Contents |
|---|---|
| `sparse-paths.txt` | Directories that git fetches with sparse checkout |
| `gitdepsignore.txt` | Whitelist of binary dependencies for the engine's `GitDependencies`. Setup copies it to `.gitdepsignore` |
| `version.json` | The commit, whether it has been verified, and the estimated download size |

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
