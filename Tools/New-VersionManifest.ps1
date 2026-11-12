# Copyright (c) 2026 Naotsun

<#
.SYNOPSIS
Generates the minimal checkout lists for one Unreal Engine commit and stores them under Versions/.

.DESCRIPTION
Run this against a full Unreal Engine checkout whose binary dependencies are already downloaded (Setup.bat of
the engine has been run). It exports the module graph of the Verse command-line target with UnrealBuildTool,
combines it with the rules in ManifestRules.psd1, and writes three files to Versions/<branch>-<commit>/:

  sparse-paths.txt  Directories for git sparse checkout (cone mode).
  gitdepsignore.txt Whitelist that Setup.ps1 copies to .gitdepsignore so GitDependencies downloads only these files.
  version.json      Commit information, the Windows SDK and MSVC toolchain the engine requires, and the
                    verification state.

The generated version starts as unverified. Run Setup.ps1 -Version <folder> into an empty folder, and when
verse.exe builds and runs the samples, set "verified" to true and fill "verifiedDate" in version.json.

.PARAMETER EngineDir
Root of the full Unreal Engine checkout (the folder that contains Engine/ and Setup.bat).

.PARAMETER Notes
Free text stored in version.json, such as what was checked.

.EXAMPLE
.\Tools\New-VersionManifest.ps1 -EngineDir 'D:\UnrealEngine'
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $EngineDir,

    [string] $Notes = ''
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Rules = Import-PowerShellDataFile -Path (Join-Path $PSScriptRoot 'ManifestRules.psd1')
$EngineDir = (Resolve-Path -Path $EngineDir).Path.TrimEnd('\')
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false

# Converts an absolute path inside the engine checkout to the forward-slash relative form used by git and
# GitDependencies.
function ConvertTo-EnginePath {
    param([string] $FullPath)

    $normalized = $FullPath.Replace('/', '\').TrimEnd('\')
    if (-not $normalized.StartsWith($EngineDir + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Module directory is outside the engine checkout: $FullPath"
    }
    return $normalized.Substring($EngineDir.Length + 1).Replace('\', '/')
}

# Returns the directory that holds the .uplugin of the plugin that owns a module directory, or $null when the
# module is not part of a plugin. The whole plugin is checked out because its descriptor and Verse sources live
# next to the module folders.
function Find-PluginRoot {
    param([string] $ModuleDir)

    $current = $ModuleDir
    while ($current.Length -gt $EngineDir.Length) {
        if (Get-ChildItem -LiteralPath $current -Filter '*.uplugin' -File -ErrorAction SilentlyContinue) {
            return $current
        }
        $current = Split-Path -Parent $current
    }
    return $null
}

# True when the path equals one of the prefixes or lies below one. Walks up the parents instead of comparing
# against every prefix, because this runs for each of the >100k files in the dependency manifest.
function Test-UnderPrefix {
    param([string] $Path, [System.Collections.Generic.HashSet[string]] $Prefixes)

    $current = $Path
    while ($true) {
        if ($Prefixes.Contains($current)) {
            return $true
        }
        $separator = $current.LastIndexOf('/')
        if ($separator -lt 0) {
            return $false
        }
        $current = $current.Substring(0, $separator)
    }
}

# True when a binary dependency is only used by another host platform. Mirrors the "/**/<folder>/" exclusions
# and the AllPlatformPaths re-inclusions that are written to gitdepsignore.txt.
function Test-OtherOsFile {
    param([string] $Path)

    if (Test-UnderPrefix -Path $Path -Prefixes $AllPlatformSet) {
        return $false
    }
    $segments = $Path.Split('/')
    for ($index = 0; $index -lt $segments.Length - 1; $index++) {
        if ($OtherOsSet.Contains($segments[$index])) {
            return $true
        }
    }
    return $false
}

function Write-TextFile {
    param([string] $Path, [string[]] $Lines)

    [System.IO.File]::WriteAllText($Path, (($Lines -join "`n") + "`n"), $Utf8NoBom)
}

# Runs git in the engine checkout and returns the first line of its output.
function Get-GitValue {
    param([string[]] $Arguments)

    $output = & git -C $EngineDir @Arguments
    if ($LASTEXITCODE -ne 0 -or $null -eq $output) {
        throw "git $($Arguments -join ' ') failed in $EngineDir. Is it a git checkout?"
    }
    return (@($output)[0]).Trim()
}

# Reads the Windows SDK range that UnrealBuildTool accepts for Win64, and the Visual Studio Installer component that
# installs the SDK the engine is built against. Setup.ps1 compares the range with the installed SDKs before it
# downloads anything, because UnrealBuildTool rejects the platform only once the build starts.
function Get-WindowsSdkRequirement {
    param([object] $SdkConfig)

    $component = @($SdkConfig.VisualStudioSuggestedComponents |
        Where-Object { $_ -match '^Microsoft\.VisualStudio\.Component\.Windows1[01]SDK\.[0-9]+$' })
    if ($component.Count -ne 1) {
        throw "Expected one Windows SDK component in VisualStudioSuggestedComponents of $SdkConfigPath."
    }
    return [ordered]@{
        minVersion = $SdkConfig.MinVersion
        maxVersion = $SdkConfig.MaxVersion
        visualStudioComponent = $component[0]
    }
}

# Reads which MSVC toolchains UnrealBuildTool accepts as the STL and libraries for the bundled EpicClang.
# UnrealBuildTool compares the ProductVersion of each toolchain's cl.exe with MinimumVisualCppVersion and
# BannedVisualCppVersions, and MinimumRequiredClangVersion maps an MSVC version to the oldest Clang that can use it,
# so MSVC versions that need a newer Clang than the bundled one are excluded with an upper bound.
function Get-VisualCppRequirement {
    param([object] $SdkConfig)

    $clangDir = Join-Path $EngineDir 'Engine\Binaries\Win64\EpicClang'
    $clangMajors = @(Get-ChildItem -LiteralPath $clangDir -Directory |
        Where-Object { $_.Name -match '^[0-9]+$' } |
        ForEach-Object { [int] $_.Name })
    if ($clangMajors.Count -eq 0) {
        throw "No bundled EpicClang was found under $clangDir. Run the engine's Setup.bat first."
    }
    $clangMajor = ($clangMajors | Measure-Object -Maximum).Maximum

    # Entries look like "14.52-22": MSVC 14.52 and later need Clang 22 or later.
    $upperBound = $null
    foreach ($entry in $SdkConfig.MinimumRequiredClangVersion) {
        $parts = $entry.Split('-')
        if ([int] $parts[1] -gt $clangMajor -and ($null -eq $upperBound -or [version] $parts[0] -lt $upperBound)) {
            $upperBound = [version] $parts[0]
        }
    }

    $component = @($SdkConfig.VisualStudio2026SuggestedComponents |
        Where-Object { $_ -match '^Microsoft\.VisualStudio\.Component\.VC\.[0-9.]+\.x86\.x64$' })
    if ($component.Count -ne 1) {
        throw "Expected one MSVC x86.x64 component in VisualStudio2026SuggestedComponents of $SdkConfigPath."
    }

    return [ordered]@{
        minVersion = $SdkConfig.MinimumVisualCppVersion
        maxVersionExclusive = $(if ($null -ne $upperBound) { $upperBound.ToString() } else { $null })
        bannedVersions = @($SdkConfig.BannedVisualCppVersions)
        minimumVisualStudioVersion = $SdkConfig.MinimumVisualStudio2022Version
        visualStudioVersion = $SdkConfig.MinimumVisualStudio2026Version
        visualStudioComponent = $component[0]
        clangMajorVersion = $clangMajor
    }
}

$commit = Get-GitValue -Arguments @('rev-parse', 'HEAD')
$branch = Get-GitValue -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')
$commitDate = Get-GitValue -Arguments @('log', '-1', '--format=%cI')
Write-Host "Engine commit: $commit ($branch, $commitDate)"
$SdkConfigPath = Join-Path $EngineDir 'Engine\Config\Windows\Windows_SDK.json'
$sdkConfig = Get-Content -LiteralPath $SdkConfigPath -Raw | ConvertFrom-Json
$windowsSdk = Get-WindowsSdkRequirement -SdkConfig $sdkConfig
Write-Host "Windows SDK: $($windowsSdk.minVersion) to $($windowsSdk.maxVersion) ($($windowsSdk.visualStudioComponent))"
$visualCpp = Get-VisualCppRequirement -SdkConfig $sdkConfig
Write-Host ("MSVC: $($visualCpp.minVersion) to below $($visualCpp.maxVersionExclusive) for EpicClang " +
    "$($visualCpp.clangMajorVersion) ($($visualCpp.visualStudioComponent))")

# Export the module graph of the target. UnrealBuildTool resolves every module, plugin and external library the
# target uses, including the ones that are only used for their headers.
$exportFile = Join-Path ([System.IO.Path]::GetTempPath()) ("VersePlayground-" + [guid]::NewGuid().ToString() + '.json')
$runUbt = Join-Path $EngineDir 'Engine\Build\BatchFiles\RunUBT.bat'
& $runUbt -Mode=JsonExport $Rules.Target $Rules.Platform $Rules.Configuration "-OutputFile=$exportFile"
if ($LASTEXITCODE -ne 0) {
    throw "UnrealBuildTool failed to export the module graph of $($Rules.Target)."
}

try {
    $export = Get-Content -LiteralPath $exportFile -Raw | ConvertFrom-Json
}
finally {
    Remove-Item -LiteralPath $exportFile -ErrorAction SilentlyContinue
}

$sparseSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
foreach ($module in $export.Modules.PSObject.Properties) {
    $moduleDir = $module.Value.Directory.Replace('/', '\')
    $owner = $null
    if ($moduleDir -like '*\Plugins\*') {
        $owner = Find-PluginRoot -ModuleDir $moduleDir
    }
    if ($null -eq $owner) {
        $owner = $moduleDir
    }
    [void] $sparseSet.Add((ConvertTo-EnginePath -FullPath $owner))
}
$moduleCount = $sparseSet.Count
foreach ($path in $Rules.ExtraSparsePaths) {
    [void] $sparseSet.Add($path)
}
[string[]] $sparsePaths = @($sparseSet)
[System.Array]::Sort($sparsePaths, [StringComparer]::Ordinal)

$AllPlatformSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
foreach ($path in $Rules.AllPlatformPaths) {
    [void] $AllPlatformSet.Add($path)
}
$OtherOsSet = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($folder in $Rules.OtherOsFolders) {
    [void] $OtherOsSet.Add($folder)
}

# GitDependencies reads .gitdepsignore with gitignore semantics where the last matching line wins:
# exclude everything, re-include root files and the checked-out directories, exclude other host platforms,
# then re-include the paths that need every platform and the single extra files.
$ignoreLines = New-Object 'System.Collections.Generic.List[string]'
$ignoreLines.Add('/**')
$ignoreLines.Add('!/*')
foreach ($path in $sparsePaths) {
    $ignoreLines.Add("!/$path/")
}
foreach ($folder in $Rules.OtherOsFolders) {
    $ignoreLines.Add("/**/$folder/")
}
foreach ($path in $sparsePaths) {
    if (Test-UnderPrefix -Path $path -Prefixes $AllPlatformSet) {
        $ignoreLines.Add("!/$path/")
    }
}
foreach ($file in $Rules.ExtraGitDependencyFiles) {
    $ignoreLines.Add("!/$file")
}

# Estimate the download by applying the same selection to the dependency manifest. GitDependencies downloads
# whole packs, so the estimate sums the packs that contain at least one selected file.
Write-Host 'Estimating the binary dependency download...'
$manifest = New-Object System.Xml.XmlDocument
$manifest.Load((Join-Path $EngineDir 'Engine\Build\Commit.gitdeps.xml'))
$blobToPack = @{}
foreach ($blob in $manifest.DependencyManifest.Blobs.Blob) {
    $blobToPack[$blob.Hash] = $blob.PackHash
}
$packSize = @{}
foreach ($pack in $manifest.DependencyManifest.Packs.Pack) {
    $packSize[$pack.Hash] = [long] $pack.CompressedSize
}
$sparseLookup = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
foreach ($path in $sparsePaths) {
    [void] $sparseLookup.Add($path)
}
$extraFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
foreach ($file in $Rules.ExtraGitDependencyFiles) {
    [void] $extraFiles.Add($file)
}
$selectedPacks = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
$selectedFiles = 0
foreach ($file in $manifest.DependencyManifest.Files.File) {
    $name = $file.Name
    $inside = (-not $name.Contains('/')) -or (Test-UnderPrefix -Path $name -Prefixes $sparseLookup)
    if ($extraFiles.Contains($name) -or ($inside -and -not (Test-OtherOsFile -Path $name))) {
        [void] $selectedPacks.Add($blobToPack[$file.Hash])
        $selectedFiles++
    }
}
$downloadBytes = [long] 0
foreach ($pack in $selectedPacks) {
    $downloadBytes += $packSize[$pack]
}
$downloadMegabytes = [math]::Round($downloadBytes / 1MB)

$folderName = ($branch -replace '[\\/:*?"<>|]', '-') + '-' + $commit.Substring(0, 12)
$outputDir = Join-Path $RepoRoot (Join-Path 'Versions' $folderName)
if (Test-Path -LiteralPath $outputDir) {
    Write-Warning "$folderName already exists. Its lists are replaced and it is marked unverified again."
}
else {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
}

$version = [ordered]@{
    commit = $commit
    branch = $branch
    commitDate = $commitDate
    generatedDate = (Get-Date -Format 'yyyy-MM-dd')
    verified = $false
    verifiedDate = $null
    estimatedGitDependenciesDownloadMB = $downloadMegabytes
    windowsSdk = $windowsSdk
    visualCpp = $visualCpp
    notes = $Notes
}

Write-TextFile -Path (Join-Path $outputDir 'sparse-paths.txt') -Lines $sparsePaths
Write-TextFile -Path (Join-Path $outputDir 'gitdepsignore.txt') -Lines $ignoreLines
Write-TextFile -Path (Join-Path $outputDir 'version.json') -Lines @(($version | ConvertTo-Json))

Write-Host ''
Write-Host "Wrote Versions/$folderName"
Write-Host "  Sparse paths       : $($sparsePaths.Count) ($moduleCount from the module graph)"
Write-Host "  Binary dependencies: $selectedFiles files, about $downloadMegabytes MB to download"
Write-Host ''
Write-Host "Next: run Setup.bat -Version $folderName into an empty folder, then mark it verified in version.json."
