# Copyright (c) 2026 Naotsun

<#
.SYNOPSIS
Downloads the minimum of Unreal Engine needed to build the Verse command-line tool (verse.exe) and builds it.

.DESCRIPTION
Setup.bat in the repository root runs this script. It:

  1. Checks that Git, Visual Studio with the C++ workload, and a Windows SDK are installed.
  2. Lets you choose one of the verified engine versions under Versions/.
  3. Fetches only that commit, and only the directories listed for it, from the Unreal Engine repository.
  4. Downloads only the binary dependencies listed for it.
  5. Builds verse.exe and runs Samples/HelloWorld/HelloWorld.verse to confirm that it works.
  6. Offers to install the Verse Playground extension into VS Code.

Your GitHub account must have access to the Unreal Engine repository. Git asks you to sign in the first time.

.PARAMETER InstallDir
Folder for the engine checkout. Defaults to UnrealEngine/ in the repository root. Running Setup again with the
same folder switches it to the chosen version and rebuilds.

.PARAMETER Version
Folder name under Versions/ or the start of a commit hash. When omitted, Setup asks which version to use.

.PARAMETER RepositoryUrl
Git URL of the Unreal Engine repository.

.PARAMETER GitDependenciesCache
Folder for the binary dependency download cache. Defaults to the cache inside the engine checkout. Point several
checkouts at one folder to download each file only once.

.PARAMETER MaxParallelActions
Number of compile processes. Defaults to a value based on the installed memory, since each compile process can
use around 3 GB.

.PARAMETER InstallExtension
Whether to install the VS Code extension in Extension/verse-playground.vsix: Ask (default), Yes or No.

.EXAMPLE
.\Setup.bat

.EXAMPLE
.\Setup.bat -Version ue6-main-f9f48a4bf1b9 -InstallDir D:\VerseEngine
#>
[CmdletBinding()]
param(
    [string] $InstallDir,

    [string] $Version,

    [string] $RepositoryUrl = 'https://github.com/EpicGames/UnrealEngine.git',

    [string] $GitDependenciesCache,

    [int] $MaxParallelActions = 0,

    [ValidateSet('Ask', 'Yes', 'No')]
    [string] $InstallExtension = 'Ask'
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$VersionsDir = Join-Path $RepoRoot 'Versions'
$LocalStateFile = Join-Path $RepoRoot 'VersePlayground.local.json'
$LocalBranch = 'verseplayground'
$MinimumGitVersion = [version] '2.27'

function Write-Step {
    param([string] $Message)

    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

# Runs a native command and stops the script when it fails. PowerShell does not stop on a non-zero exit code by
# itself, so every git and engine tool call goes through here.
function Invoke-Native {
    param([string] $FilePath, [string[]] $Arguments)

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$(Split-Path -Leaf $FilePath) failed with exit code $LASTEXITCODE."
    }
}

function Test-Prerequisites {
    Write-Step 'Checking prerequisites'

    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) {
        throw 'Git is not installed or not on PATH. Install Git for Windows from https://git-scm.com/ and run Setup again.'
    }
    # "git version 2.53.0.windows.2" -> 2.53.0. Sparse checkout in cone mode with partial clone needs 2.27.
    $gitVersionText = (& git --version) -replace '^git version ([0-9]+\.[0-9]+(\.[0-9]+)?).*$', '$1'
    if ([version] $gitVersionText -lt $MinimumGitVersion) {
        throw "Git $gitVersionText is too old. Update to Git $MinimumGitVersion or later."
    }
    Write-Host "Git $gitVersionText"

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $visualStudio = $null
    if (Test-Path -LiteralPath $vswhere) {
        $visualStudio = & $vswhere -latest -products * `
            -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
            -property displayName
    }
    if (-not $visualStudio) {
        throw ('Visual Studio with the "Desktop development with C++" workload was not found. ' +
            'Install it with the Visual Studio Installer and run Setup again.')
    }
    Write-Host "$visualStudio"

    $windowsKits = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' `
        -Name KitsRoot10 -ErrorAction SilentlyContinue
    if ($null -eq $windowsKits) {
        throw ('No Windows 10/11 SDK was found. Add a Windows SDK in the Visual Studio Installer ' +
            '(Individual components) and run Setup again.')
    }
    Write-Host "Windows SDK at $($windowsKits.KitsRoot10)"
}

# Reads every Versions/<folder>/version.json, newest commit first.
function Get-EngineVersions {
    $versions = foreach ($folder in Get-ChildItem -LiteralPath $VersionsDir -Directory) {
        $infoPath = Join-Path $folder.FullName 'version.json'
        if (Test-Path -LiteralPath $infoPath) {
            $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
            [pscustomobject] @{
                Name = $folder.Name
                Directory = $folder.FullName
                Commit = $info.commit
                Branch = $info.branch
                CommitDate = [datetimeoffset] $info.commitDate
                Verified = [bool] $info.verified
                Notes = $info.notes
            }
        }
    }
    return @($versions | Sort-Object -Property CommitDate -Descending)
}

function Select-EngineVersion {
    param([object[]] $Versions)

    if ($Versions.Count -eq 0) {
        throw "No engine versions were found in $VersionsDir."
    }

    if ($Version) {
        $match = @($Versions | Where-Object {
            $_.Name -eq $Version -or $_.Commit.StartsWith($Version, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($match.Count -ne 1) {
            throw "-Version '$Version' matched $($match.Count) versions. Use a folder name from Versions/."
        }
        return $match[0]
    }

    Write-Step 'Choose an engine version'
    for ($index = 0; $index -lt $Versions.Count; $index++) {
        $entry = $Versions[$index]
        $state = if ($entry.Verified) { 'verified' } else { 'NOT verified' }
        Write-Host ("  [{0}] {1}  {2:yyyy-MM-dd}  {3}" -f ($index + 1), $entry.Name, $entry.CommitDate, $state)
        if ($entry.Notes) {
            Write-Host "      $($entry.Notes)"
        }
    }

    # The newest verified version is the default, so pressing Enter never picks an unverified one.
    $default = 0
    for ($index = 0; $index -lt $Versions.Count; $index++) {
        if ($Versions[$index].Verified) {
            $default = $index
            break
        }
    }
    $answer = Read-Host "Version number (Enter for $($default + 1))"
    if ([string]::IsNullOrWhiteSpace($answer)) {
        return $Versions[$default]
    }
    $choice = 0
    if (-not [int]::TryParse($answer, [ref] $choice) -or $choice -lt 1 -or $choice -gt $Versions.Count) {
        throw "'$answer' is not a number from the list."
    }
    return $Versions[$choice - 1]
}

# Brings the checkout to the chosen commit with only the listed directories. The sparse checkout is configured
# before the first fetch, so files outside the list are never written. With --filter=blob:none the server sends
# file contents only for the paths that are checked out.
function Update-EngineCheckout {
    param([object] $EngineVersion)

    Write-Step "Fetching $($EngineVersion.Name) into $InstallDir"

    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir '.git'))) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        Invoke-Native git @('-C', $InstallDir, 'init', '--quiet')
        Invoke-Native git @('-C', $InstallDir, 'remote', 'add', 'origin', $RepositoryUrl)
    }

    # Engine paths are deep, so long path support avoids checkout failures under a long InstallDir.
    Invoke-Native git @('-C', $InstallDir, 'config', 'core.longpaths', 'true')
    # The repository was not created by "git clone --filter", so mark origin as the remote that can supply the
    # omitted file contents later. Without this, the checkout cannot fetch the files it needs.
    Invoke-Native git @('-C', $InstallDir, 'config', 'remote.origin.promisor', 'true')
    Invoke-Native git @('-C', $InstallDir, 'config', 'remote.origin.partialclonefilter', 'blob:none')

    $sparsePaths = @(Get-Content -LiteralPath (Join-Path $EngineVersion.Directory 'sparse-paths.txt') |
        Where-Object { $_ })
    Invoke-Native git (@('-C', $InstallDir, 'sparse-checkout', 'set', '--cone') + $sparsePaths)

    Invoke-Native git @('-C', $InstallDir, 'fetch', '--depth', '1', '--filter=blob:none', 'origin',
        $EngineVersion.Commit)
    Invoke-Native git @('-C', $InstallDir, 'switch', '--quiet', '--force-create', $LocalBranch, $EngineVersion.Commit)
}

function Update-BinaryDependencies {
    param([object] $EngineVersion)

    Write-Step 'Downloading binary dependencies'

    # GitDependencies reads .gitdepsignore from the checkout root and skips every file it excludes.
    Copy-Item -LiteralPath (Join-Path $EngineVersion.Directory 'gitdepsignore.txt') `
        -Destination (Join-Path $InstallDir '.gitdepsignore') -Force

    $gitDependencies = Join-Path $InstallDir 'Engine\Binaries\DotNET\GitDependencies\win-x64\GitDependencies.exe'
    $arguments = @()
    if ($GitDependenciesCache) {
        $arguments += "--cache=$GitDependenciesCache"
    }
    Invoke-Native $gitDependencies $arguments
}

function Get-DefaultParallelActions {
    $memoryGigabytes = (Get-CimInstance -ClassName Win32_ComputerSystem).TotalPhysicalMemory / 1GB
    $byMemory = [math]::Floor($memoryGigabytes / 3)
    return [int] [math]::Max(1, [math]::Min([Environment]::ProcessorCount, $byMemory))
}

function Invoke-VerseBuild {
    Write-Step 'Building verse.exe (the first build takes several minutes)'

    $parallel = $MaxParallelActions
    if ($parallel -le 0) {
        $parallel = Get-DefaultParallelActions
    }
    Write-Host "Using up to $parallel compile processes"

    $runUbt = Join-Path $InstallDir 'Engine\Build\BatchFiles\RunUBT.bat'
    Invoke-Native $runUbt @('VerseCmd', 'Win64', 'Development', "-MaxParallelActions=$parallel")
}

function Test-VerseExecutable {
    param([string] $VersePath)

    Write-Step 'Running Samples/HelloWorld/HelloWorld.verse'

    $sample = Join-Path $RepoRoot 'Samples\HelloWorld\HelloWorld.verse'
    $output = & $VersePath $sample
    $output | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0 -or -not ($output -match 'Hello')) {
        throw 'verse.exe was built but did not run the sample correctly.'
    }
}

# Records where verse.exe is so that other tools in this repository, such as the VS Code extension, can find it.
function Save-LocalState {
    param([object] $EngineVersion, [string] $VersePath)

    $state = [ordered] @{
        engineDir = $InstallDir
        versePath = $VersePath
        version = $EngineVersion.Name
        commit = $EngineVersion.Commit
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($LocalStateFile, ($state | ConvertTo-Json) + "`n", $utf8NoBom)
}

# Installs the extension that runs, debugs and highlights Verse files in VS Code. The extension reads the location of
# verse.exe from the local state file, so it is installed after that file is written.
function Install-VSCodeExtension {
    $vsix = Join-Path $RepoRoot 'Extension\verse-playground.vsix'
    if (-not (Test-Path -LiteralPath $vsix)) {
        return
    }

    $code = Get-Command code -ErrorAction SilentlyContinue
    if ($null -eq $code) {
        Write-Host ''
        Write-Host 'VS Code was not found on PATH. To use the VS Code extension, install it from:'
        Write-Host "  $vsix"
        return
    }

    $shouldInstall = $InstallExtension -eq 'Yes'
    if ($InstallExtension -eq 'Ask') {
        Write-Step 'VS Code extension'
        Write-Host 'The Verse Playground extension runs and debugs Verse files from VS Code and highlights them.'
        $answer = Read-Host 'Install it into VS Code? [Y/n]'
        $shouldInstall = [string]::IsNullOrWhiteSpace($answer) -or $answer -match '^[Yy]'
    }
    if (-not $shouldInstall) {
        Write-Host "Skipped. You can install it later from $vsix"
        return
    }

    Invoke-Native $code.Source @('--install-extension', $vsix, '--force')
    Write-Host "Open $RepoRoot in VS Code and open a .verse file to start."
}

if (-not $InstallDir) {
    $InstallDir = Join-Path $RepoRoot 'UnrealEngine'
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

Test-Prerequisites
$engineVersion = Select-EngineVersion -Versions (Get-EngineVersions)
if (-not $engineVersion.Verified) {
    Write-Warning "$($engineVersion.Name) has not been verified. The build may fail."
}
Update-EngineCheckout -EngineVersion $engineVersion
Update-BinaryDependencies -EngineVersion $engineVersion
Invoke-VerseBuild

$versePath = Join-Path $InstallDir 'Engine\Binaries\Win64\verse.exe'
Test-VerseExecutable -VersePath $versePath
Save-LocalState -EngineVersion $engineVersion -VersePath $versePath
Install-VSCodeExtension

Write-Step 'Done'
Write-Host "verse.exe: $versePath"
Write-Host 'Run a Verse file with:'
Write-Host "  `"$versePath`" <file.verse> [arguments]"
