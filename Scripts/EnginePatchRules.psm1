# Copyright (c) 2026 Naotsun

# Checks that an engine patch in Patches/ stays within what the Unreal Engine EULA lets this repository publish.
# Section 5(a)(ii) allows distributing snippets of Engine Code, up to 30 lines, with a patch, as long as the snippets
# are not put together into a larger part of the engine. A patch quotes the engine in its context lines and its
# removed lines, which are the old side of each hunk, so the old line counts in the hunk headers are what it quotes.

Set-StrictMode -Version 3.0

$MaxQuotedEngineLines = 30

# Returns how many engine lines a patch quotes, in total and for each engine file, and what breaks the rules.
function Get-EnginePatchReport {
    param([Parameter(Mandatory)] [string] $Path)

    $quotedByFile = [ordered] @{}
    $problems = New-Object 'System.Collections.Generic.List[string]'
    $currentFile = $null
    $isNewFile = $false
    $hasEpicCopyright = $false

    foreach ($line in (Get-Content -LiteralPath $Path)) {
        if ($line -match '^diff --git a/.+ b/(.+)$') {
            $currentFile = $Matches[1]
            $isNewFile = $false
            if (-not $quotedByFile.Contains($currentFile)) {
                $quotedByFile[$currentFile] = 0
            }
            continue
        }
        # The explanation above the first diff is not part of the patch.
        if ($null -eq $currentFile) {
            continue
        }

        if ($line -match '^@@ -\d+(?:,(\d+))? \+\d+(?:,\d+)? @@(.*)$') {
            # A hunk header without a count means one line.
            $oldCount = if ($Matches[1]) { [int] $Matches[1] } else { 1 }
            # git also copies the line of the enclosing function after the header. git apply ignores it, so the
            # patches here leave it out, but a patch that keeps it quotes one more line.
            if ($Matches[2].Trim()) {
                $oldCount += 1
            }
            $quotedByFile[$currentFile] += $oldCount
        }
        elseif ($line -match '^new file mode ') {
            $isNewFile = $true
        }
        elseif ($line -match '^copy from ') {
            $problems.Add("It copies an engine file into $currentFile.")
        }
        elseif ($line -match '^GIT binary patch' -or $line -match '^Binary files .+ differ$') {
            $problems.Add("It changes the binary file $currentFile.")
        }
        elseif ($isNewFile -and -not $hasEpicCopyright -and $line -match '^\+.*Copyright Epic Games') {
            # A new file with Epic's copyright notice is most likely an engine file copied whole.
            $hasEpicCopyright = $true
            $problems.Add("The new file $currentFile has Epic's copyright notice, so it looks copied from the engine.")
        }
    }

    $quotedTotal = 0
    foreach ($count in $quotedByFile.Values) {
        $quotedTotal += $count
    }
    if ($quotedTotal -gt $MaxQuotedEngineLines) {
        $problems.Add("It quotes $quotedTotal lines of engine code; the limit is $MaxQuotedEngineLines.")
    }

    return [pscustomobject] @{
        Path = $Path
        QuotedLines = $quotedTotal
        QuotedLinesByFile = $quotedByFile
        Problems = $problems.ToArray()
    }
}

# Returns the engine files that the given patches quote more than the limit from when taken together, so that
# several small patches do not add up to a larger part of one file.
function Get-EnginePatchSetProblems {
    param([Parameter(Mandatory)] [object[]] $Reports)

    $quotedByFile = @{}
    foreach ($report in $Reports) {
        foreach ($file in $report.QuotedLinesByFile.Keys) {
            $quotedByFile[$file] = [int] $quotedByFile[$file] + $report.QuotedLinesByFile[$file]
        }
    }

    $problemList = foreach ($file in ($quotedByFile.Keys | Sort-Object)) {
        if ($quotedByFile[$file] -gt $MaxQuotedEngineLines) {
            "The patches together quote $($quotedByFile[$file]) lines of $file; the limit is $MaxQuotedEngineLines."
        }
    }
    return @($problemList)
}

Export-ModuleMember -Function Get-EnginePatchReport, Get-EnginePatchSetProblems -Variable MaxQuotedEngineLines
