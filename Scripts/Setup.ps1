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
  6. Builds verse.exe and runs Samples/HelloWorld/HelloWorld.verse to confirm that it works.
  7. Offers to install the Verse Playground extension into VS Code.

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
    [string] $InstallBuildTools = 'Ask',

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
$VsWherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$VsInstallerPath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\setup.exe'
$WindowsKitsKey = 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots'

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

    $instancesJson = (& $VsWherePath -all -products * -format json -utf8) | Out-String
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

    $logPath = Join-Path ([System.IO.Path]::GetTempPath()) 'VersePlayground-VisualStudioInstaller.log'
    Write-Host "Installing into $($plan.Description). The installer's log goes to $logPath"
    $exitCode = Invoke-VisualStudioInstaller -Arguments $plan.Arguments -LogPath $logPath -ManualSteps $manualSteps

    # The installer may restart itself to update first, so its exit code alone does not prove the result.
    $stillMissing = @(Get-MissingBuildComponents -SdkRequirement $sdkRequirement -CppRequirement $cppRequirement)
    if ($stillMissing.Count -gt 0) {
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
    return [pscustomobject] @{
        Description = "a new Visual Studio Build Tools $major in $installPath"
        Arguments = @(
            'install',
            '--channelId', "VisualStudio.$major.Release",
            '--channelUri', "https://aka.ms/vs/$major/release/channel",
            '--productId', 'Microsoft.VisualStudio.Product.BuildTools',
            '--installPath', $installPath
        ) + $addArguments + @('--passive', '--norestart')
    }
}

# Runs the Visual Studio Installer as administrator through a hidden PowerShell, so that its log goes to a file
# instead of filling this console. Start-Process -Wait also waits for the copy the installer starts when it updates
# itself. Returns the exit code.
function Invoke-VisualStudioInstaller {
    param([string[]] $Arguments, [string] $LogPath, [string] $ManualSteps)

    $quotedArguments = foreach ($argument in $Arguments) { "'" + $argument.Replace("'", "''") + "'" }
    $command = ("& '{0}' {1} *> '{2}'; exit `$LASTEXITCODE" -f
        $VsInstallerPath.Replace("'", "''"), ($quotedArguments -join ' '), $LogPath.Replace("'", "''"))
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
Confirm-BuildToolchain -EngineVersion $engineVersion
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
