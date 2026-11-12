# Copyright (c) 2026 Naotsun

<#
.SYNOPSIS
Checks that the engine patches in Patches/ can be published under the Unreal Engine EULA.

.DESCRIPTION
Section 5(a)(ii) of the Unreal Engine EULA allows distributing snippets of Engine Code of up to 30 lines with a
patch, as long as they are not put together into a larger part of the engine. A patch quotes the engine in its
context lines and its removed lines. This script fails when:

  - a patch quotes more than 30 lines of engine code,
  - the patches together quote more than 30 lines of one engine file,
  - a patch copies an engine file, adds a file with Epic's copyright notice, or changes a binary file.

Run it before committing a new or changed patch.

.PARAMETER Path
Patch files to check. Defaults to every Patches/*.patch.

.EXAMPLE
.\Tools\Test-EnginePatches.ps1
#>
[CmdletBinding()]
param(
    [string[]] $Path
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $RepoRoot 'Scripts\EnginePatchRules.psm1') -Force

if (-not $Path) {
    $Path = @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'Patches') -Filter '*.patch' -File |
        ForEach-Object { $_.FullName })
}

$reports = @($Path | ForEach-Object { Get-EnginePatchReport -Path $_ })
$failed = $false
foreach ($report in $reports) {
    $name = Split-Path -Leaf $report.Path
    Write-Host "$name quotes $($report.QuotedLines) of $MaxQuotedEngineLines engine lines"
    foreach ($problem in $report.Problems) {
        Write-Host "  $problem" -ForegroundColor Red
        $failed = $true
    }
}
if ($reports.Count -gt 0) {
    foreach ($problem in (Get-EnginePatchSetProblems -Reports $reports)) {
        Write-Host $problem -ForegroundColor Red
        $failed = $true
    }
}

if ($failed) {
    Write-Host 'Make the patches smaller (for example with git diff -U1) before publishing them.' -ForegroundColor Red
    exit 1
}
Write-Host 'All patches are within the limit.'
