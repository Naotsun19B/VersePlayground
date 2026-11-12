# Copyright (c) 2026 Naotsun

<#
.SYNOPSIS
Downloads the minimum of Unreal Engine needed to build the Verse command-line tool (verse.exe) and builds it.

.DESCRIPTION
Setup.bat in the repository root runs this script. It:

  1. Checks that Git is installed.
  2. Lets you choose one of the verified engine versions under Versions/.
  3. Checks that the Windows SDK and the MSVC toolchain that version needs are installed, and offers to install
     what is missing with the Visual Studio Installer.
  4. Fetches only that commit, and only the directories listed for it, from the Unreal Engine repository.
  5. Downloads only the binary dependencies listed for it.
  6. Applies the engine patches in Patches/ that the version needs, and the optional ones you choose.
  7. Builds verse.exe and runs Samples/HelloWorld/HelloWorld.verse to confirm that it works.
  8. Offers to install the Verse Playground extension into VS Code.

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

.PARAMETER InstallBuildTools
Whether to install the Windows SDK and MSVC toolchain that the engine needs when they are missing: Ask (default),
Yes or No. Installing runs the Visual Studio Installer, which asks Windows for administrator permission. The MSVC
toolchain goes into Visual Studio 2026, or into a new Visual Studio 2026 Build Tools when there is none.

.PARAMETER InstallExtension
Whether to install the VS Code extension in Extension/verse-playground.vsix: Ask (default), Yes or No.

.PARAMETER Patches
Optional engine patches to apply, by file name in Patches/ without .patch, separated by commas. "none" applies
only the patches that the chosen version needs. When omitted, Setup asks, and pressing Enter keeps the patches
chosen last time. The patches that the version needs are always applied.

.EXAMPLE
.\Setup.bat

.EXAMPLE
.\Setup.bat -Version ue6-main-f9f48a4bf1b9 -InstallDir D:\VerseEngine

.EXAMPLE
.\Setup.bat -Patches none
#>
[CmdletBinding()]
param(
    [string] $InstallDir,

    [string] $Version,

    [string] $RepositoryUrl = 'https://github.com/EpicGames/UnrealEngine.git',

    [string] $GitDependenciesCache,

    [int] $MaxParallelActions = 0,

    [ValidateSet('Ask', 'Yes', 'No')]
    [string] $InstallBuildTools = 'Ask',

    [ValidateSet('Ask', 'Yes', 'No')]
    [string] $InstallExtension = 'Ask',

    # A string rather than string[], because Setup.bat passes "a,b" through -File as one argument.
    [string] $Patches
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$VersionsDir = Join-Path $RepoRoot 'Versions'
$PatchesDir = Join-Path $RepoRoot 'Patches'
$LocalStateFile = Join-Path $RepoRoot 'VersePlayground.local.json'
$LocalBranch = 'verseplayground'
$MinimumGitVersion = [version] '2.27'
$VsWherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$VsInstallerPath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\setup.exe'
$WindowsKitsKey = 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots'

Import-Module (Join-Path $PSScriptRoot 'EnginePatchRules.psm1') -Force

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
    # Visual Studio is checked after a version is chosen, because the version says which toolchain it needs.
}

# Lists the installed Visual Studio products, Build Tools included, newest first.
function Get-VisualStudioInstances {
    if (-not (Test-Path -LiteralPath $VsWherePath)) {
        return @()
    }

    # vswhere -utf8 writes UTF-8, but Windows PowerShell decodes native output with the console code page. On a
    # Japanese system that garbles the localized descriptions, can swallow their closing quotes and breaks the JSON.
    $previousEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
        $instancesJson = (& $VsWherePath -all -products * -format json -utf8) | Out-String
    }
    finally {
        [Console]::OutputEncoding = $previousEncoding
    }
    $instances = foreach ($instance in ($instancesJson | ConvertFrom-Json)) {
        [pscustomobject] @{
            DisplayName = $instance.displayName
            InstallationPath = $instance.installationPath
            Version = [version] $instance.installationVersion
        }
    }
    return @($instances | Sort-Object -Property Version -Descending)
}

# Lists the MSVC toolchains of the Visual Studio products that UnrealBuildTool considers. UnrealBuildTool ignores
# products older than the minimum version, and judges a toolchain by the version of its cl.exe, which can be newer
# than the toolchain's folder name.
function Get-VisualCppToolchains {
    param([version] $MinimumVisualStudioVersion)

    $toolchains = foreach ($instance in Get-VisualStudioInstances) {
        $msvcDir = Join-Path $instance.InstallationPath 'VC\Tools\MSVC'
        if ($instance.Version -lt $MinimumVisualStudioVersion -or -not (Test-Path -LiteralPath $msvcDir)) {
            continue
        }

        foreach ($folder in Get-ChildItem -LiteralPath $msvcDir -Directory) {
            $compiler = Join-Path $folder.FullName 'bin\Hostx64\x64\cl.exe'
            if (-not (Test-Path -LiteralPath $compiler)) {
                continue
            }

            $versionInfo = (Get-Item -LiteralPath $compiler).VersionInfo
            [pscustomobject] @{
                Version = [version] ('{0}.{1}.{2}' -f $versionInfo.ProductMajorPart, $versionInfo.ProductMinorPart,
                    $versionInfo.ProductBuildPart)
                VisualStudio = $instance.DisplayName
            }
        }
    }
    return @($toolchains)
}

# True when UnrealBuildTool accepts an MSVC toolchain of this cl.exe version: not older than the minimum, below the
# version that would need a newer Clang than the bundled one, and outside every banned range.
function Test-AcceptedVisualCpp {
    param([version] $ToolchainVersion, [object] $Requirement)

    if ($ToolchainVersion -lt [version] $Requirement.minVersion) {
        return $false
    }

    if ($Requirement.maxVersionExclusive -and $ToolchainVersion -ge [version] $Requirement.maxVersionExclusive) {
        return $false
    }

    foreach ($bannedRange in $Requirement.bannedVersions) {
        $bounds = $bannedRange.Split('-')
        if ($ToolchainVersion -ge [version] $bounds[0] -and $ToolchainVersion -le [version] $bounds[1]) {
            return $false
        }
    }
    return $true
}

# Lists the Windows 10/11 SDK versions that have their headers installed, the same way UnrealBuildTool finds them:
# a version folder under Include/ of the Windows Kits root that contains um/Windows.h.
function Get-InstalledWindowsSdkVersions {
    $windowsKits = Get-ItemProperty -Path $WindowsKitsKey -Name KitsRoot10 -ErrorAction SilentlyContinue
    if ($null -eq $windowsKits) {
        return @()
    }

    $includeDir = Join-Path $windowsKits.KitsRoot10 'Include'
    if (-not (Test-Path -LiteralPath $includeDir)) {
        return @()
    }
    $versions = foreach ($folder in Get-ChildItem -LiteralPath $includeDir -Directory) {
        $sdkVersion = $null
        if (
            [version]::TryParse($folder.Name, [ref] $sdkVersion) -and
            (Test-Path -LiteralPath (Join-Path $folder.FullName 'um\Windows.h'))
        ) {
            $sdkVersion
        }
    }
    return @($versions | Sort-Object)
}

# Returns what the chosen engine version needs to build but is not installed, as objects with the Visual Studio
# component that provides it. Prints what was found for the rest.
function Get-MissingBuildComponents {
    param([object] $SdkRequirement, [object] $CppRequirement)

    $missing = New-Object 'System.Collections.Generic.List[object]'

    $minimumSdk = [version] $SdkRequirement.minVersion
    $maximumSdk = [version] $SdkRequirement.maxVersion
    $installedSdks = @(Get-InstalledWindowsSdkVersions)
    $suitableSdks = @($installedSdks | Where-Object { $_ -ge $minimumSdk -and $_ -le $maximumSdk })
    if ($suitableSdks.Count -gt 0) {
        Write-Host "Windows SDK $($suitableSdks[-1])"
    }
    else {
        # Setup.bat runs Windows PowerShell 5.1, which has no ternary operator.
        $installedText = if ($installedSdks.Count -gt 0) { $installedSdks -join ', ' } else { 'none' }
        $missing.Add([pscustomobject] @{
            Name = "Windows SDK $minimumSdk"
            Component = $SdkRequirement.visualStudioComponent
            NeedsVisualStudioVersion = $null
            Problem = "Windows SDK $minimumSdk or later is not installed (installed: $installedText)."
            ManualStep = "add `"Windows 11 SDK ($minimumSdk)`" (Individual components)"
        })
    }

    $toolchains = @(Get-VisualCppToolchains -MinimumVisualStudioVersion $CppRequirement.minimumVisualStudioVersion)
    $acceptedToolchains = @($toolchains |
        Where-Object { Test-AcceptedVisualCpp -ToolchainVersion $_.Version -Requirement $CppRequirement } |
        Sort-Object -Property Version)
    $rangeText = "$($CppRequirement.minVersion) or later"
    if ($CppRequirement.maxVersionExclusive) {
        $rangeText += " and below $($CppRequirement.maxVersionExclusive)"
    }
    if ($acceptedToolchains.Count -gt 0) {
        Write-Host "MSVC $($acceptedToolchains[-1].Version) in $($acceptedToolchains[-1].VisualStudio)"
    }
    else {
        $foundText = if ($toolchains.Count -gt 0) {
            ($toolchains.Version | Sort-Object -Unique) -join ', '
        }
        else {
            'none'
        }
        $problem = ("An MSVC toolchain $rangeText is not installed in Visual Studio " +
            "$($CppRequirement.minimumVisualStudioVersion) or later (toolchains found there: $foundText).")
        $oldInstances = @(Get-VisualStudioInstances |
            Where-Object { $_.Version -lt [version] $CppRequirement.minimumVisualStudioVersion })
        if ($oldInstances.Count -gt 0) {
            $oldText = ($oldInstances | ForEach-Object { "$($_.DisplayName) $($_.Version.ToString(2))" }) -join ', '
            $problem += " UnrealBuildTool ignores older products: $oldText."
        }
        $missing.Add([pscustomobject] @{
            Name = "MSVC toolchain $($CppRequirement.minVersion)"
            Component = $CppRequirement.visualStudioComponent
            NeedsVisualStudioVersion = [version] $CppRequirement.visualStudioVersion
            Problem = $problem
            ManualStep = ("install Visual Studio 2026 or Visual Studio 2026 Build Tools with " +
                "`"MSVC Build Tools v$(([version] $CppRequirement.minVersion).ToString(2)) for x64/x86`"")
        })
    }
    return $missing.ToArray()
}

# Makes sure the Windows SDK and MSVC toolchain that the chosen engine version needs are installed, before anything
# is downloaded. UnrealBuildTool only reports them when the build starts, after the engine has been fetched.
function Confirm-BuildToolchain {
    param([object] $EngineVersion)

    Write-Step 'Checking the Windows SDK and the MSVC toolchain'

    $sdkRequirement = $EngineVersion.WindowsSdk
    $cppRequirement = $EngineVersion.VisualCpp
    if ($null -eq $sdkRequirement -or $null -eq $cppRequirement) {
        Write-Warning "$($EngineVersion.Name) does not record which build tools it needs, so they are not checked."
        return
    }

    $missing = @(Get-MissingBuildComponents -SdkRequirement $sdkRequirement -CppRequirement $cppRequirement)
    if ($missing.Count -eq 0) {
        return
    }

    foreach ($item in $missing) {
        Write-Warning $item.Problem
    }
    $manualSteps = ('In the Visual Studio Installer, ' + (($missing | ForEach-Object { $_.ManualStep }) -join '; ') +
        ', then run Setup again.')
    $plan = Get-BuildToolsInstallPlan -Missing $missing -CppRequirement $cppRequirement

    $shouldInstall = $InstallBuildTools -eq 'Yes'
    if ($InstallBuildTools -eq 'Ask') {
        Write-Host "The build fails without them. Setup can install them now with the Visual Studio Installer:"
        Write-Host "  $(($missing | ForEach-Object { $_.Name }) -join ', ') -> $($plan.Description)"
        Write-Host 'Windows asks for administrator permission, and Visual Studio must be closed while it installs.'
        $answer = Read-Host 'Install them now? [Y/n]'
        $shouldInstall = [string]::IsNullOrWhiteSpace($answer) -or $answer -match '^[Yy]'
    }
    if (-not $shouldInstall) {
        throw "The engine cannot be built without them. $manualSteps"
    }

    if (-not (Test-Path -LiteralPath $VsInstallerPath)) {
        throw ('The Visual Studio Installer was not found. Download Visual Studio 2026 Build Tools from ' +
            "https://visualstudio.microsoft.com/downloads/ and $manualSteps")
    }

    Write-Host "Installing into $($plan.Description)."
    $startTime = Get-Date
    $exitCode = Invoke-VisualStudioInstaller -Arguments $plan.Arguments -ManualSteps $manualSteps

    # The installer may restart itself to update first, so its exit code alone does not prove the result.
    $stillMissing = @(Get-MissingBuildComponents -SdkRequirement $sdkRequirement -CppRequirement $cppRequirement)
    if ($stillMissing.Count -gt 0) {
        $logPath = Get-VisualStudioInstallerLog -Since $startTime
        throw ("The Visual Studio Installer finished (exit code $exitCode), but " +
            "$(($stillMissing | ForEach-Object { $_.Name }) -join ' and ') is still missing. Close Visual Studio " +
            "and try again, or see $logPath. $manualSteps")
    }
}

# Decides which Visual Studio product receives the missing components. The MSVC toolchain the engine needs only
# ships with Visual Studio 2026, so without one a separate Visual Studio 2026 Build Tools is installed next to the
# existing products. A Windows SDK alone can go into any installed product.
function Get-BuildToolsInstallPlan {
    param([object[]] $Missing, [object] $CppRequirement)

    $components = @($Missing | ForEach-Object { $_.Component })
    $neededVersions = @($Missing | Where-Object { $null -ne $_.NeedsVisualStudioVersion } |
        ForEach-Object { $_.NeedsVisualStudioVersion })
    $minimumVersion = if ($neededVersions.Count -gt 0) { $neededVersions[0] } else { [version] '0.0' }
    $target = @(Get-VisualStudioInstances | Where-Object { $_.Version -ge $minimumVersion }) | Select-Object -First 1

    # --passive shows the installer's progress without asking anything, and --norestart leaves restarting to the
    # user.
    $addArguments = foreach ($component in $components) { '--add'; $component }
    if ($null -ne $target) {
        return [pscustomobject] @{
            Description = $target.DisplayName
            Arguments = @('modify', '--installPath', $target.InstallationPath) + $addArguments +
                @('--passive', '--norestart')
        }
    }

    $major = ([version] $CppRequirement.visualStudioVersion).Major
    $installPath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\$major\BuildTools"
    # Visual Studio 2026 (18) publishes its release channel as "stable"; aka.ms/vs/18/release/channel does not
    # exist and redirects to bing.com, which the installer rejects as an invalid channel manifest. The channel ID
    # inside the manifest is still VisualStudio.18.Release.
    $channelName = if ($major -ge 18) { 'stable' } else { 'release' }
    return [pscustomobject] @{
        Description = "a new Visual Studio Build Tools $major in $installPath"
        Arguments = @(
            'install',
            '--channelId', "VisualStudio.$major.Release",
            '--channelUri', "https://aka.ms/vs/$major/$channelName/channel",
            '--productId', 'Microsoft.VisualStudio.Product.BuildTools',
            '--installPath', $installPath
        ) + $addArguments + @('--passive', '--norestart')
    }
}

# Returns the newest log the Visual Studio Installer wrote to %TEMP% since the given time, or the log folder when
# there is none. The installer writes nothing to the console, so its own dd_installer_*.log is the only record.
function Get-VisualStudioInstallerLog {
    param([datetime] $Since)

    $tempDir = [System.IO.Path]::GetTempPath()
    $log = Get-ChildItem -LiteralPath $tempDir -Filter 'dd_installer_*.log' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $Since.AddSeconds(-5) } |
        Sort-Object -Property LastWriteTime -Descending |
        Select-Object -First 1
    if ($null -ne $log) {
        return $log.FullName
    }
    return Join-Path $tempDir 'dd_installer_*.log'
}

# Runs the Visual Studio Installer as administrator through a hidden PowerShell. Start-Process -Wait also waits for
# the copy the installer starts when it updates itself. Returns the exit code.
function Invoke-VisualStudioInstaller {
    param([string[]] $Arguments, [string] $ManualSteps)

    $quotedArguments = foreach ($argument in $Arguments) { "'" + $argument.Replace("'", "''") + "'" }
    # setup.exe is a GUI program, so PowerShell waits for it and sets $LASTEXITCODE only when its output is piped.
    $command = ("& '{0}' {1} | Out-Null; exit `$LASTEXITCODE" -f
        $VsInstallerPath.Replace("'", "''"), ($quotedArguments -join ' '))
    $encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($command))
    try {
        $installer = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encodedCommand)
    }
    catch {
        throw "The Visual Studio Installer did not start (administrator permission was refused?). $ManualSteps"
    }
    return $installer.ExitCode
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
                # Versions generated before the build tools were recorded have no windowsSdk or visualCpp entry.
                WindowsSdk = $(if ($info.PSObject.Properties['windowsSdk']) { $info.windowsSdk } else { $null })
                VisualCpp = $(if ($info.PSObject.Properties['visualCpp']) { $info.visualCpp } else { $null })
                # Names of the files in Patches/ that this version needs, without .patch.
                Patches = $(if ($info.PSObject.Properties['patches']) { @($info.patches) } else { @() })
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
    param([object] $EngineVersion, [object] $PreviousState)

    Write-Step "Fetching $($EngineVersion.Name) into $InstallDir"

    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir '.git'))) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        Invoke-Native git @('-C', $InstallDir, 'init', '--quiet')
        Invoke-Native git @('-C', $InstallDir, 'remote', 'add', 'origin', $RepositoryUrl)
    }
    else {
        # Patched files would stop git from switching commits, and every patch is applied again afterwards.
        Undo-EnginePatches -PreviousState $PreviousState
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

# Reads the state file that the last Setup wrote, or returns $null when there is none or it cannot be read.
function Read-LocalState {
    if (-not (Test-Path -LiteralPath $LocalStateFile)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $LocalStateFile -Raw | ConvertFrom-Json
    }
    catch {
        Write-Warning "$LocalStateFile could not be read, so the patches chosen last time are not known: $_"
        return $null
    }
}

# Returns a list property of the state file, or an empty list when the state file or the property is missing.
function Get-LocalStateList {
    param([object] $State, [string] $Name)

    if ($null -eq $State -or -not $State.PSObject.Properties[$Name]) {
        return @()
    }
    return @($State.$Name | Where-Object { $_ })
}

# Lists Patches/*.patch. The first "Title:" line of a file is its title. git apply skips the text before the first
# diff, so each patch carries its own explanation at the top.
function Get-EnginePatches {
    if (-not (Test-Path -LiteralPath $PatchesDir)) {
        return @()
    }

    $patchList = foreach ($file in Get-ChildItem -LiteralPath $PatchesDir -Filter '*.patch' -File) {
        $titleLine = Get-Content -LiteralPath $file.FullName -TotalCount 10 |
            Where-Object { $_ -match '^Title:' } |
            Select-Object -First 1
        [pscustomobject] @{
            Name = $file.BaseName
            Path = $file.FullName
            Title = $(if ($titleLine) { ($titleLine -replace '^Title:\s*', '') } else { $file.BaseName })
        }
    }
    return @($patchList | Sort-Object -Property Name)
}

# Decides which optional patches to apply, before anything is downloaded, so that Setup asks all its questions
# first. Optional patches are the ones in Patches/ that the chosen version does not need.
function Select-OptionalPatches {
    param([object] $EngineVersion, [object] $PreviousState)

    $candidates = @(Get-EnginePatches | Where-Object { $EngineVersion.Patches -notcontains $_.Name })
    $candidateNames = @($candidates | ForEach-Object { $_.Name })

    if ($Patches) {
        $requested = @($Patches.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        if ($requested.Count -eq 1 -and $requested[0] -eq 'none') {
            return @()
        }

        foreach ($name in $requested) {
            if ($EngineVersion.Patches -contains $name) {
                Write-Host "$name is always applied to $($EngineVersion.Name), so -Patches does not need it."
            }
            elseif ($candidateNames -notcontains $name) {
                throw "-Patches names '$name', but there is no Patches/$name.patch."
            }
        }
        return @($requested | Where-Object { $candidateNames -contains $_ })
    }

    if ($candidates.Count -eq 0) {
        return @()
    }

    # The previous choice is the default. A patch that has since been removed from Patches/ drops out of it.
    $previous = @(Get-LocalStateList -State $PreviousState -Name 'optionalPatches' |
        Where-Object { $candidateNames -contains $_ })

    Write-Step 'Choose optional engine patches'
    for ($index = 0; $index -lt $candidates.Count; $index++) {
        $mark = if ($previous -contains $candidates[$index].Name) { 'x' } else { ' ' }
        Write-Host ("  [{0}] ({1}) {2}" -f ($index + 1), $mark, $candidates[$index].Name)
        Write-Host "        $($candidates[$index].Title)"
    }
    $answer = Read-Host 'Numbers separated by commas, 0 for none, Enter to keep the ones marked with x'
    if ([string]::IsNullOrWhiteSpace($answer)) {
        return $previous
    }
    if ($answer.Trim() -eq '0') {
        return @()
    }

    $chosen = foreach ($part in $answer.Split(',')) {
        $choice = 0
        if (-not [int]::TryParse($part.Trim(), [ref] $choice) -or $choice -lt 1 -or $choice -gt $candidates.Count) {
            throw "'$($part.Trim())' is not a number from the list."
        }
        $candidates[$choice - 1].Name
    }
    return @($chosen | Select-Object -Unique)
}

# Runs git and returns whether it succeeded, without showing its output. Windows PowerShell turns what a native
# command writes to stderr into errors that stop the script, so the preference is relaxed while git runs.
function Test-GitCommand {
    param([string[]] $Arguments)

    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & git @Arguments 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

# Restores the files that the last Setup patched in this checkout to their committed content.
function Undo-EnginePatches {
    param([object] $PreviousState)

    if ($null -eq $PreviousState -or -not $PreviousState.PSObject.Properties['engineDir']) {
        return
    }
    # The state file describes one checkout. Another -InstallDir is a different checkout with its own files.
    $previousDir = [System.IO.Path]::GetFullPath($PreviousState.engineDir)
    if (-not [string]::Equals($previousDir, $InstallDir, [StringComparison]::OrdinalIgnoreCase)) {
        return
    }

    $patchedFiles = @(Get-LocalStateList -State $PreviousState -Name 'patchedFiles')
    # A checkout whose first fetch failed has no commit to restore from yet.
    if ($patchedFiles.Count -eq 0 -or -not (Test-GitCommand @('-C', $InstallDir, 'rev-parse', '--verify', 'HEAD'))) {
        return
    }
    # A patch can also add files that the engine does not have. Restoring those means deleting them.
    $trackedFiles = @($patchedFiles | Where-Object { Test-GitCommand @('-C', $InstallDir, 'cat-file', '-e', "HEAD:$_") })
    foreach ($addedFile in @($patchedFiles | Where-Object { $trackedFiles -notcontains $_ })) {
        $addedPath = Join-Path $InstallDir $addedFile
        if (Test-Path -LiteralPath $addedPath) {
            Remove-Item -LiteralPath $addedPath
        }
    }
    if ($trackedFiles.Count -gt 0) {
        Invoke-Native git (@('-C', $InstallDir, 'restore', '--source=HEAD', '--staged', '--worktree', '--') +
            $trackedFiles)
    }
}

# Applies the patches that the chosen version needs and the chosen optional ones. A needed patch that does not apply
# stops Setup, because the version is known to need it; an optional one is skipped with a warning. Returns the
# applied patch names and the files they changed, for the state file.
function Install-EnginePatches {
    param([object] $EngineVersion, [string[]] $OptionalPatches)

    Write-Step 'Applying engine patches'

    $available = @(Get-EnginePatches)
    $applied = New-Object 'System.Collections.Generic.List[string]'
    $patchedFiles = New-Object 'System.Collections.Generic.List[string]'
    $planned = @($EngineVersion.Patches | ForEach-Object { [pscustomobject] @{ Name = $_; Needed = $true } }) +
        @($OptionalPatches | ForEach-Object { [pscustomobject] @{ Name = $_; Needed = $false } })
    if ($planned.Count -eq 0) {
        Write-Host 'None'
    }

    foreach ($entry in $planned) {
        $patch = $available | Where-Object { $_.Name -eq $entry.Name } | Select-Object -First 1
        if ($null -eq $patch) {
            throw "$($EngineVersion.Name) needs Patches/$($entry.Name).patch, which does not exist."
        }

        # A patch of your own is fine on your own computer, so Setup only warns; publishing it is what the EULA limits.
        foreach ($problem in (Get-EnginePatchReport -Path $patch.Path).Problems) {
            Write-Warning "Patches/$($patch.Name).patch: $problem Do not publish this patch (see Engine patches in README.md)."
        }

        if (Test-GitCommand @('-C', $InstallDir, 'apply', '--check', $patch.Path)) {
            Invoke-Native git @('-C', $InstallDir, 'apply', $patch.Path)
            Write-Host "Applied $($patch.Name): $($patch.Title)"
        }
        elseif (Test-GitCommand @('-C', $InstallDir, 'apply', '--reverse', '--check', $patch.Path)) {
            # A checkout patched by hand, or by a Setup that stopped before it wrote the state file.
            Write-Host "Already applied $($patch.Name): $($patch.Title)"
        }
        elseif ($entry.Needed) {
            throw ("Patches/$($patch.Name).patch does not apply to $($EngineVersion.Name), which needs it. " +
                'Update the patch or the "patches" list in its version.json.')
        }
        else {
            Write-Warning "Skipped $($patch.Name): it does not apply to $($EngineVersion.Name)."
            continue
        }

        $applied.Add($patch.Name)
        # --numstat prints "added<TAB>deleted<TAB>path" for each file the patch changes.
        foreach ($line in (& git -C $InstallDir apply --numstat $patch.Path)) {
            $patchedFiles.Add(($line -split "`t", 3)[2])
        }
    }

    return [pscustomobject] @{
        Names = $applied.ToArray()
        Files = @($patchedFiles | Select-Object -Unique)
    }
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
    param([object] $EngineVersion, [string] $VersePath, [string[]] $OptionalPatches, [object] $PatchResult)

    # optionalPatches is the user's choice, kept even when a patch did not apply to this version; patches and
    # patchedFiles describe what is applied now, so that the next Setup can undo it.
    $state = [ordered] @{
        engineDir = $InstallDir
        versePath = $VersePath
        version = $EngineVersion.Name
        commit = $EngineVersion.Commit
        patches = @($PatchResult.Names)
        optionalPatches = @($OptionalPatches)
        patchedFiles = @($PatchResult.Files)
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
$previousState = Read-LocalState
$engineVersion = Select-EngineVersion -Versions (Get-EngineVersions)
if (-not $engineVersion.Verified) {
    Write-Warning "$($engineVersion.Name) has not been verified. The build may fail."
}
$optionalPatches = @(Select-OptionalPatches -EngineVersion $engineVersion -PreviousState $previousState)
Confirm-BuildToolchain -EngineVersion $engineVersion
Update-EngineCheckout -EngineVersion $engineVersion -PreviousState $previousState
Update-BinaryDependencies -EngineVersion $engineVersion
$patchResult = Install-EnginePatches -EngineVersion $engineVersion -OptionalPatches $optionalPatches
Invoke-VerseBuild

$versePath = Join-Path $InstallDir 'Engine\Binaries\Win64\verse.exe'
Test-VerseExecutable -VersePath $versePath
Save-LocalState -EngineVersion $engineVersion -VersePath $versePath -OptionalPatches $optionalPatches `
    -PatchResult $patchResult
Install-VSCodeExtension

Write-Step 'Done'
Write-Host "verse.exe: $versePath"
Write-Host 'Run a Verse file with:'
Write-Host "  `"$versePath`" <file.verse> [arguments]"
