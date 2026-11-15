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

When -VersePath is given, the script also runs command tests against that verse.exe, which must have been built with
Patches/verse-ide-analysis.patch. They cover the editor request mode (--ide-request: ping, check, hover, definition,
malformed requests, four requests at once) and running a folder as one program. They build their .verse inputs in a
temporary folder that is deleted at the end, and do not touch the repository. Without -VersePath only the quoted line
count is checked.

.PARAMETER Path
Patch files to check. Defaults to every Patches/*.patch.

.PARAMETER VersePath
Path of a patched verse.exe. Turns on the command tests.

.EXAMPLE
.\Tools\Test-EnginePatches.ps1

.EXAMPLE
.\Tools\Test-EnginePatches.ps1 -VersePath F:\VerseEngine\UnrealEngine\Engine\Binaries\Win64\verse.exe
#>
[CmdletBinding()]
param(
    [string[]] $Path,
    [string] $VersePath
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

if (-not $VersePath) {
    return
}

# ---------------------------------------------------------------------------------------------------------------------
# Command tests against a patched verse.exe
# ---------------------------------------------------------------------------------------------------------------------

if (-not (Test-Path -LiteralPath $VersePath -PathType Leaf)) {
    Write-Host "verse.exe was not found: $VersePath" -ForegroundColor Red
    exit 1
}
$VersePath = (Resolve-Path -LiteralPath $VersePath).ProviderPath

$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
$script:CaseFailures = New-Object System.Collections.Generic.List[string]
$script:CaseCount = 0

# Maximum number of .verse files in one program, and of overrides in one request.
$MaxProgramFiles = 500

function Get-Field {
    param([object] $Object, [string] $Name)

    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) {
        return $Object.$Name
    }
    return $null
}

function Assert-That {
    param([bool] $Condition, [string] $Message)

    if (-not $Condition) {
        throw $Message
    }
}

# Runs one case. A failed assertion or any other exception fails only that case.
function Test-Case {
    param([string] $Name, [scriptblock] $Body)

    $script:CaseCount++
    try {
        & $Body
        Write-Host "  ok    $Name"
    }
    catch {
        Write-Host "  FAIL  $Name" -ForegroundColor Red
        Write-Host "        $($_.Exception.Message)" -ForegroundColor Red
        $script:CaseFailures.Add($Name)
    }
}

function ConvertTo-IdePath {
    param([string] $FilePath)

    return $FilePath.Replace('\', '/')
}

function Set-TestFile {
    param([string] $FilePath, [string] $Text)

    $parent = Split-Path -Parent $FilePath
    if (-not (Test-Path -LiteralPath $parent)) {
        [void] (New-Item -ItemType Directory -Path $parent -Force)
    }
    [System.IO.File]::WriteAllText($FilePath, $Text, $Utf8NoBom)
}

# Creates a new folder under the test root and fills it with the given file name -> text pairs.
function New-TestFolder {
    param([string] $Name, [hashtable] $Files)

    $folder = Join-Path $TestRoot $Name
    [void] (New-Item -ItemType Directory -Path $folder -Force)
    foreach ($fileName in $Files.Keys) {
        Set-TestFile -FilePath (Join-Path $folder $fileName) -Text $Files[$fileName]
    }
    return $folder
}

# Returns the 0-based line and UTF-8 byte column of the Occurrence-th (0-based) Needle in Text, plus Delta bytes.
function Get-TextPosition {
    param([string] $Text, [string] $Needle, [int] $Occurrence = 0, [int] $Delta = 0)

    $index = -1
    for ($i = 0; $i -le $Occurrence; $i++) {
        $index = $Text.IndexOf($Needle, $index + 1, [System.StringComparison]::Ordinal)
        if ($index -lt 0) {
            throw "The test text has no occurrence $Occurrence of '$Needle'."
        }
    }
    $before = $Text.Substring(0, $index)
    $line = ($before.ToCharArray() | Where-Object { $_ -eq "`n" } | Measure-Object).Count
    $lineStart = $before.LastIndexOf("`n") + 1
    $byte = $Utf8NoBom.GetByteCount($before.Substring($lineStart)) + $Delta
    return @{ line = $line; byte = $byte }
}

# Builds the JSON of a request. Overrides is an array of @{ path = ...; text = ... }.
function New-IdeRequestJson {
    param(
        [string] $Kind,
        [string] $Folder,
        [string] $Target,
        [hashtable] $Position,
        [object[]] $Overrides = @(),
        [int] $Protocol = 1
    )

    $request = [ordered] @{ protocol = $Protocol; kind = $Kind }
    if ($Folder) {
        $request['folder'] = ConvertTo-IdePath $Folder
    }
    if ($Target) {
        $request['target'] = ConvertTo-IdePath $Target
    }
    if ($Position) {
        $request['position'] = $Position
    }
    $request['overrides'] = @($Overrides)
    return ConvertTo-Json -InputObject $request -Depth 6 -Compress
}

# Starts verse.exe with the arguments and hands Stdin to it as UTF-8 without a BOM. Returns a handle for
# Wait-VerseProcess. Several handles can be alive at once.
function Start-VerseProcess {
    param([string] $Arguments, [string] $Stdin, [string] $WorkingDirectory)

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $VersePath
    $startInfo.Arguments = $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = $Utf8NoBom
    $startInfo.StandardErrorEncoding = $Utf8NoBom
    if ($WorkingDirectory) {
        $startInfo.WorkingDirectory = $WorkingDirectory
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    [void] $process.Start()

    # Reading starts before stdin is written, so a process that fills its output pipe while it is still reading
    # stdin cannot block against this script.
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    # Writing the bytes to the base stream avoids the encoding of StandardInput, which may carry a BOM.
    $bytes = $Utf8NoBom.GetBytes($Stdin)
    try {
        $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
        $process.StandardInput.BaseStream.Flush()
    }
    catch [System.IO.IOException] {
        # The process ended without reading stdin. Its exit code and stderr tell why.
    }
    $process.StandardInput.Close()

    return [pscustomobject] @{
        Process = $process
        StdoutTask = $stdoutTask
        StderrTask = $stderrTask
    }
}

function Wait-VerseProcess {
    param([object] $Handle, [int] $TimeoutSeconds = 120)

    $process = $Handle.Process
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            throw "verse.exe did not finish within $TimeoutSeconds seconds."
        }
        return [pscustomobject] @{
            ExitCode = $process.ExitCode
            Stdout = $Handle.StdoutTask.Result
            Stderr = $Handle.StderrTask.Result
        }
    }
    finally {
        $process.Dispose()
    }
}

# Picks the answer line out of the output of --ide-request and parses it.
function ConvertTo-IdeResponse {
    param([object] $Result)

    $line = $Result.Stdout -split "`r?`n" | Where-Object { $_.StartsWith('@verse-ide ') } | Select-Object -First 1
    $missingLineMessage = "No '@verse-ide ' answer line. Exit code $($Result.ExitCode). " +
        "stderr: $($Result.Stderr.Trim())"
    Assert-That ([bool] $line) $missingLineMessage
    return $line.Substring('@verse-ide '.Length) | ConvertFrom-Json
}

# Sends one request and returns @{ Response; ExitCode; Stdout; Stderr }.
function Invoke-IdeRequest {
    param([string] $RequestJson)

    $result = Wait-VerseProcess (Start-VerseProcess -Arguments '--ide-request' -Stdin $RequestJson)
    return [pscustomobject] @{
        Response = ConvertTo-IdeResponse $result
        ExitCode = $result.ExitCode
        Stdout = $result.Stdout
        Stderr = $result.Stderr
    }
}

# Runs verse.exe on a script like a user does and returns @{ ExitCode; Stdout; Stderr }.
function Invoke-VerseRun {
    param([string[]] $ScriptArguments, [string] $WorkingDirectory)

    $quoted = ($ScriptArguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    return Wait-VerseProcess (Start-VerseProcess -Arguments $quoted -Stdin '' -WorkingDirectory $WorkingDirectory)
}

function Assert-ResponseOk {
    param([object] $Reply)

    $reason = Get-Field $Reply.Response 'error'
    Assert-That ((Get-Field $Reply.Response 'ok') -eq $true) "The request was refused: $reason"
    Assert-That ($Reply.ExitCode -eq 0) "The exit code was $($Reply.ExitCode), not 0."
}

function Assert-ResponseRefused {
    param([object] $Reply)

    Assert-That ((Get-Field $Reply.Response 'ok') -eq $false) 'The request should have been refused with ok: false.'
    Assert-That ([bool] (Get-Field $Reply.Response 'error')) 'The refusal has no error text.'
    Assert-That ($Reply.ExitCode -eq 1) "The exit code was $($Reply.ExitCode), not 1."
}

# Returns the diagnostics of one severity. PowerShell unrolls the returned array, so callers that need .Count or an
# index wrap the call in @(): under StrictMode an empty result is $null and a single result has no Count property.
function Get-Diagnostics {
    param([object] $Reply, [string] $Severity)

    return @(@(Get-Field $Reply.Response 'diagnostics') | Where-Object { $_.severity -eq $Severity })
}

$TestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('VerseIdeTest-' + [guid]::NewGuid().ToString('N'))
[void] (New-Item -ItemType Directory -Path $TestRoot)

try {
    Write-Host ''
    Write-Host "Command tests with $VersePath"

    # --- ping and the samples ---------------------------------------------------------------------------------------

    Test-Case 'ping is answered with ok: true' {
        $reply = Invoke-IdeRequest '{"protocol":1,"kind":"ping"}'
        Assert-ResponseOk $reply
        Assert-That ((Get-Field $reply.Response 'protocol') -eq 1) 'The answer does not carry protocol 1.'
    }

    $sampleFolders = @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'Samples') -Directory |
        Where-Object { @(Get-ChildItem -LiteralPath $_.FullName -Filter '*.verse' -File).Count -gt 0 })
    foreach ($sample in $sampleFolders) {
        $sampleFolder = $sample.FullName
        Test-Case "check of Samples/$($sample.Name) reports no errors or warnings" {
            $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $sampleFolder)
            Assert-ResponseOk $reply
            $problems = @(@(Get-Field $reply.Response 'diagnostics') | Where-Object { $_.severity -ne 'info' })
            # The message is built only on failure, because indexing an empty array throws under StrictMode.
            if ($problems.Count -gt 0) {
                throw "$($problems.Count) problems, the first: $($problems[0].message)"
            }
        }
    }

    # --- check: errors and text handling ----------------------------------------------------------------------------

    $semanticText = "Main():void =`n    Y:int = Undefined`n"
    $semanticFolder = New-TestFolder 'semantic' @{ 'Main.verse' = $semanticText }
    Test-Case 'check reports a semantic error at the right place' {
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $semanticFolder)
        Assert-ResponseOk $reply
        $errors = @(Get-Diagnostics $reply 'error')
        Assert-That ($errors.Count -ge 1) 'No error was reported.'
        $expected = Get-TextPosition $semanticText 'Undefined'
        $match = @($errors | Where-Object {
                $_.range.start.line -eq $expected.line -and $_.range.start.byte -eq $expected.byte
            })
        Assert-That ($match.Count -ge 1) 'No error starts at the unknown identifier.'
        Assert-That ($match[0].path -eq (ConvertTo-IdePath (Join-Path $semanticFolder 'Main.verse'))) `
            "The path of the error is '$($match[0].path)'."
        Assert-That ($match[0].range.end.byte -eq ($expected.byte + 9)) 'The error does not end after the identifier.'
    }

    $syntaxFolder = New-TestFolder 'syntax' @{ 'Main.verse' = "Main():void =`n    X := (`n" }
    Test-Case 'check reports a syntax error' {
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $syntaxFolder)
        Assert-ResponseOk $reply
        Assert-That (@(Get-Diagnostics $reply 'error').Count -ge 1) 'No error was reported.'
    }

    # Non-ASCII text is built from code points, because Windows PowerShell 5.1 reads a script without a BOM as ANSI.
    $japanese = -join ([char[]] (0x65E5, 0x672C, 0x8A9E))
    $japaneseText = "# $japanese`nMain():void =`n    Z:[]string = array{`"$japanese`", Undefined}`n"
    $japaneseFolder = New-TestFolder 'japanese' @{ 'Main.verse' = $japaneseText }
    Test-Case 'check counts columns in UTF-8 bytes on a line with Japanese text' {
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $japaneseFolder)
        Assert-ResponseOk $reply
        $expected = Get-TextPosition $japaneseText 'Undefined'
        $match = @(Get-Diagnostics $reply 'error' | Where-Object {
                $_.range.start.line -eq $expected.line -and $_.range.start.byte -eq $expected.byte
            })
        Assert-That ($match.Count -ge 1) "No error starts at line $($expected.line), byte $($expected.byte)."
    }

    $japaneseFileName = "$japanese.verse"
    $japanesePathFolder = New-TestFolder "folder $japanese" @{ $japaneseFileName = $semanticText }
    Test-Case 'check handles a Japanese folder and file name' {
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $japanesePathFolder)
        Assert-ResponseOk $reply
        $errors = @(Get-Diagnostics $reply 'error')
        Assert-That ($errors.Count -ge 1) 'No error was reported.'
        Assert-That ($errors[0].path -eq (ConvertTo-IdePath (Join-Path $japanesePathFolder $japaneseFileName))) `
            "The path of the error is '$($errors[0].path)'."
    }

    $crlfFolder = New-TestFolder 'crlf' @{ 'Main.verse' = $semanticText.Replace("`n", "`r`n") }
    Test-Case 'check gives the same position for CRLF line endings' {
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $crlfFolder)
        Assert-ResponseOk $reply
        $expected = Get-TextPosition $semanticText 'Undefined'
        $match = @(Get-Diagnostics $reply 'error' | Where-Object {
                $_.range.start.line -eq $expected.line -and $_.range.start.byte -eq $expected.byte
            })
        Assert-That ($match.Count -ge 1) "No error starts at line $($expected.line), byte $($expected.byte)."
    }

    Test-Case 'check uses the text of an override instead of the file on disk' {
        $mainPath = Join-Path $semanticFolder 'Main.verse'
        # Print has the suspends effect, so the function that calls it needs it too.
        $override = @{ path = (ConvertTo-IdePath $mainPath); text = "Main()<suspends>:void =`n    Print(`"fixed`")`n" }
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $semanticFolder -Overrides @($override))
        Assert-ResponseOk $reply
        Assert-That (@(Get-Diagnostics $reply 'error').Count -eq 0) 'The error of the file on disk was still reported.'
    }

    Test-Case 'check accepts an empty override and does not read the file on disk' {
        $mainPath = Join-Path $semanticFolder 'Main.verse'
        $override = @{ path = (ConvertTo-IdePath $mainPath); text = '' }
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $semanticFolder -Overrides @($override))
        Assert-ResponseOk $reply
        Assert-That (@(Get-Diagnostics $reply 'error').Count -eq 0) 'The empty override fell back to the file on disk.'
    }

    Test-Case 'check accepts an override for a file that is not on disk' {
        $newPath = Join-Path $semanticFolder 'Unsaved.verse'
        $override = @{ path = (ConvertTo-IdePath $newPath); text = "Broken():void =`n    Y:int = Missing`n" }
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $semanticFolder -Overrides @($override))
        Assert-ResponseOk $reply
        $inNewFile = @(Get-Diagnostics $reply 'error' | Where-Object { $_.path -eq (ConvertTo-IdePath $newPath) })
        Assert-That ($inNewFile.Count -ge 1) 'The unsaved file was not part of the program.'
    }

    # --- check: malformed requests ----------------------------------------------------------------------------------

    $folderJson = ConvertTo-Json -InputObject (ConvertTo-IdePath $semanticFolder)
    $mainJson = ConvertTo-Json -InputObject (ConvertTo-IdePath (Join-Path $semanticFolder 'Main.verse'))
    $otherJson = ConvertTo-Json -InputObject (ConvertTo-IdePath (Join-Path $semanticFolder 'Other.verse'))
    $subJson = ConvertTo-Json -InputObject (ConvertTo-IdePath (Join-Path $semanticFolder 'sub/Other.verse'))
    $textFileJson = ConvertTo-Json -InputObject (ConvertTo-IdePath (Join-Path $semanticFolder 'Other.txt'))
    $refused = [ordered] @{
        'not JSON' = 'this is not json'
        'an empty request' = ''
        'a JSON array' = '[]'
        'protocol 2' = '{"protocol":2,"kind":"ping"}'
        'no protocol' = '{"kind":"ping"}'
        'an unknown kind' = '{"protocol":1,"kind":"format"}'
        'no folder' = '{"protocol":1,"kind":"check","overrides":[]}'
        'a relative folder' = '{"protocol":1,"kind":"check","folder":"relative/folder","overrides":[]}'
        'a folder with backslashes only and no drive' = '{"protocol":1,"kind":"check","folder":"\\Main","overrides":[]}'
        'overrides that is not an array' = '{"protocol":1,"kind":"check","folder":' + $folderJson + ',"overrides":{}}'
        'an override without text' = '{"protocol":1,"kind":"check","folder":' + $folderJson +
            ',"overrides":[{"path":' + $mainJson + '}]}'
        'an override without path' = '{"protocol":1,"kind":"check","folder":' + $folderJson +
            ',"overrides":[{"text":"x"}]}'
        'an override with a relative path' = '{"protocol":1,"kind":"check","folder":' + $folderJson +
            ',"overrides":[{"path":"Main.verse","text":"x"}]}'
        'an override in a subfolder' = '{"protocol":1,"kind":"check","folder":' + $folderJson +
            ',"overrides":[{"path":' + $subJson + ',"text":"x"}]}'
        'an override that is not a .verse file' = '{"protocol":1,"kind":"check","folder":' + $folderJson +
            ',"overrides":[{"path":' + $textFileJson + ',"text":"x"}]}'
        'two overrides for the same path' = '{"protocol":1,"kind":"check","folder":' + $folderJson +
            ',"overrides":[{"path":' + $otherJson + ',"text":"x"},{"path":' + $otherJson + ',"text":"y"}]}'
        'a hover without target' = '{"protocol":1,"kind":"hover","folder":' + $folderJson +
            ',"position":{"line":0,"byte":0},"overrides":[]}'
        'a hover without position' = '{"protocol":1,"kind":"hover","folder":' + $folderJson + ',"target":' +
            $mainJson + ',"overrides":[]}'
        'a definition with a negative position' = '{"protocol":1,"kind":"definition","folder":' + $folderJson +
            ',"target":' + $mainJson + ',"position":{"line":-1,"byte":0},"overrides":[]}'
    }
    foreach ($name in $refused.Keys) {
        $json = $refused[$name]
        Test-Case "request with $name is refused with ok: false and exit code 1" {
            Assert-ResponseRefused (Invoke-IdeRequest $json)
        }
    }

    Test-Case 'a request with more than 500 overrides is refused' {
        $overrides = @(1..($MaxProgramFiles + 1) | ForEach-Object {
                @{ path = (ConvertTo-IdePath (Join-Path $semanticFolder ('O{0:D3}.verse' -f $_))); text = "`n" }
            })
        Assert-ResponseRefused (Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $semanticFolder `
                    -Overrides $overrides))
    }

    # --- hover and definition ---------------------------------------------------------------------------------------

    $libText = "Helper(X:int):int = X + 1`nHelper(S:string):string = S`n"
    $mainText = "Main()<suspends>:void =`n    V := Helper(1)`n    Print(`"{V}`")`n    W := Helper(`"s`")`n"
    $hoverFolder = New-TestFolder 'hover' @{ 'Lib.verse' = $libText; 'Main.verse' = $mainText }
    $hoverMain = Join-Path $hoverFolder 'Main.verse'
    $hoverLib = Join-Path $hoverFolder 'Lib.verse'

    Test-Case 'the program of the hover folder has no errors' {
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $hoverFolder)
        Assert-ResponseOk $reply
        Assert-That (@(Get-Diagnostics $reply 'error').Count -eq 0) 'The folder used by the hover cases has errors.'
    }

    Test-Case 'hover on a function defined in another file shows its signature' {
        $position = Get-TextPosition $mainText 'Helper' -Delta 1
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'hover' -Folder $hoverFolder -Target $hoverMain `
                -Position $position)
        Assert-ResponseOk $reply
        $hover = Get-Field $reply.Response 'hover'
        Assert-That ($null -ne $hover) 'No hover was returned.'
        Assert-That ($hover.text -like '*Helper*') "The hover text is '$($hover.text)'."
    }

    Test-Case 'hover picks the overload that the call uses' {
        $position = Get-TextPosition $mainText 'Helper' -Occurrence 1 -Delta 1
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'hover' -Folder $hoverFolder -Target $hoverMain `
                -Position $position)
        Assert-ResponseOk $reply
        $hover = Get-Field $reply.Response 'hover'
        Assert-That ($null -ne $hover) 'No hover was returned.'
        # The compiler shows string as its definition []char, so the overload is recognized by its parameter name.
        Assert-That ($hover.text -like '*Helper(S:*') "The hover text is '$($hover.text)'."
    }

    Test-Case 'definition of a function in another file points into that file' {
        $position = Get-TextPosition $mainText 'Helper' -Delta 1
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'definition' -Folder $hoverFolder -Target $hoverMain `
                -Position $position)
        Assert-ResponseOk $reply
        $definition = Get-Field $reply.Response 'definition'
        Assert-That ($null -ne $definition) 'No definition was returned.'
        Assert-That ($definition.path -eq (ConvertTo-IdePath $hoverLib)) "The definition is in '$($definition.path)'."
        Assert-That ($definition.range.start.line -eq 0) 'The definition is not on the first line of Lib.verse.'
    }

    Test-Case 'definition of a local variable points to its declaration' {
        $position = Get-TextPosition $mainText 'V}'
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'definition' -Folder $hoverFolder -Target $hoverMain `
                -Position $position)
        Assert-ResponseOk $reply
        $definition = Get-Field $reply.Response 'definition'
        Assert-That ($null -ne $definition) 'No definition was returned.'
        Assert-That ($definition.path -eq (ConvertTo-IdePath $hoverMain)) "The definition is in '$($definition.path)'."
        Assert-That ($definition.range.start.line -eq 1) 'The definition is not on the line of the declaration.'
    }

    Test-Case 'definition of Print points outside the folder' {
        $position = Get-TextPosition $mainText 'Print' -Delta 1
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'definition' -Folder $hoverFolder -Target $hoverMain `
                -Position $position)
        Assert-ResponseOk $reply
        $definition = Get-Field $reply.Response 'definition'
        Assert-That ($null -ne $definition) 'No definition was returned for Print.'
        Assert-That (-not $definition.path.StartsWith((ConvertTo-IdePath $hoverFolder))) `
            'The definition of Print is inside the test folder.'
    }

    Test-Case 'hover on Print returns a result' {
        $position = Get-TextPosition $mainText 'Print' -Delta 1
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'hover' -Folder $hoverFolder -Target $hoverMain `
                -Position $position)
        Assert-ResponseOk $reply
        Assert-That ($null -ne (Get-Field $reply.Response 'hover')) 'No hover was returned for Print.'
    }

    Test-Case 'definition on the definition itself returns null' {
        $position = Get-TextPosition $libText 'Helper' -Delta 1
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'definition' -Folder $hoverFolder -Target $hoverLib `
                -Position $position)
        Assert-ResponseOk $reply
        Assert-That ($null -eq (Get-Field $reply.Response 'definition')) 'A definition was returned for a definition.'
    }

    Test-Case 'hover on blank space returns null' {
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'hover' -Folder $hoverFolder -Target $hoverMain `
                -Position @{ line = 0; byte = 200 })
        Assert-ResponseOk $reply
        Assert-That ($null -eq (Get-Field $reply.Response 'hover')) 'A hover was returned past the end of the line.'
    }

    Test-Case 'hover in a file with a syntax error still answers' {
        $position = @{ line = 0; byte = 1 }
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'hover' -Folder $syntaxFolder `
                -Target (Join-Path $syntaxFolder 'Main.verse') -Position $position)
        Assert-ResponseOk $reply
        Assert-That (@(Get-Diagnostics $reply 'error').Count -ge 1) 'The syntax error was not reported with the hover.'
    }

    Test-Case 'hover uses the text of an override' {
        $newText = "Helper(X:int):int = X + 2`nHelper(S:string):string = S`nExtra():void = {}`n"
        $override = @{ path = (ConvertTo-IdePath $hoverLib); text = $newText }
        $position = Get-TextPosition $mainText 'Helper' -Delta 1
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'definition' -Folder $hoverFolder -Target $hoverMain `
                -Position $position -Overrides @($override))
        Assert-ResponseOk $reply
        Assert-That ($null -ne (Get-Field $reply.Response 'definition')) 'No definition was returned.'
    }

    # --- running a folder as one program ----------------------------------------------------------------------------

    $programFolder = New-TestFolder 'program' @{
        'Main.verse' = "Main(Args:[]string, Env:[string]string)<suspends>:void =`n    Print(`"answer={Answer()}`")`n"
        'Lib.verse' = "Answer():int = 42`n"
    }

    Test-Case 'running a script calls a function defined in another file of the folder' {
        $run = Invoke-VerseRun -ScriptArguments @((Join-Path $programFolder 'Main.verse'))
        Assert-That ($run.ExitCode -eq 0) "Exit code $($run.ExitCode). stderr: $($run.Stderr.Trim())"
        Assert-That ($run.Stdout -like '*answer=42*') "Unexpected output: $($run.Stdout.Trim())"
    }

    Test-Case 'running a script by a relative path resolves it from the launch directory' {
        $run = Invoke-VerseRun -ScriptArguments @('Main.verse') -WorkingDirectory $programFolder
        Assert-That ($run.ExitCode -eq 0) "Exit code $($run.ExitCode). stderr: $($run.Stderr.Trim())"
        Assert-That ($run.Stdout -like '*answer=42*') "Unexpected output: $($run.Stdout.Trim())"
    }

    Test-Case 'running a script by a relative path with a folder part' {
        $run = Invoke-VerseRun -ScriptArguments @('program\Main.verse') -WorkingDirectory $TestRoot
        Assert-That ($run.ExitCode -eq 0) "Exit code $($run.ExitCode). stderr: $($run.Stderr.Trim())"
        Assert-That ($run.Stdout -like '*answer=42*') "Unexpected output: $($run.Stdout.Trim())"
    }

    $twoMainsFolder = New-TestFolder 'two-mains' @{
        'Main.verse' = "Main(Args:[]string, Env:[string]string)<suspends>:void =`n    Print(`"first`")`n"
        'Other.verse' = "Main(Args:[]string, Env:[string]string)<suspends>:void =`n    Print(`"second`")`n"
    }
    Test-Case 'a folder with two Main functions does not run' {
        $run = Invoke-VerseRun -ScriptArguments @((Join-Path $twoMainsFolder 'Main.verse'))
        Assert-That ($run.ExitCode -ne 0) 'verse.exe ran a program that has two Main functions.'
    }

    $brokenSiblingFolder = New-TestFolder 'broken-sibling' @{
        'Main.verse' = "Main(Args:[]string, Env:[string]string)<suspends>:void =`n    Print(`"ran=1`")`n"
        'Broken.verse' = "Broken():void =`n    Y:int = Undefined`n"
    }
    Test-Case 'a compile error in another file of the folder stops the run' {
        $run = Invoke-VerseRun -ScriptArguments @((Join-Path $brokenSiblingFolder 'Main.verse'))
        Assert-That ($run.ExitCode -ne 0) 'verse.exe ran a program with a compile error in a sibling file.'
        Assert-That ($run.Stdout -notlike '*ran=1*') 'The program printed output despite the compile error.'
    }

    $filesAtLimit = @{
        'Main.verse' = "Main(Args:[]string, Env:[string]string)<suspends>:void =`n    Print(`"many files`")`n"
    }
    foreach ($number in 1..($MaxProgramFiles - 1)) {
        $filesAtLimit['F{0:D3}.verse' -f $number] = "F{0:D3}():int = {1}`n" -f $number, $number
    }
    $limitFolder = New-TestFolder 'files-500' $filesAtLimit
    Test-Case 'a folder with 500 files is one program' {
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $limitFolder)
        Assert-ResponseOk $reply
        Assert-That (@(Get-Diagnostics $reply 'error').Count -eq 0) 'The folder with 500 files has errors.'
    }

    $overFolder = Join-Path $TestRoot 'files-501'
    Copy-Item -LiteralPath $limitFolder -Destination $overFolder -Recurse
    Set-TestFile -FilePath (Join-Path $overFolder 'F500.verse') -Text "F500():int = 500`n"
    Test-Case 'a check of a folder with 501 files is refused' {
        Assert-ResponseRefused (Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $overFolder))
    }
    Test-Case 'running a script in a folder with 501 files fails with a message' {
        $run = Invoke-VerseRun -ScriptArguments @((Join-Path $overFolder 'Main.verse'))
        Assert-That ($run.ExitCode -ne 0) 'verse.exe ran a folder with more files than one program may have.'
        Assert-That ($run.Stderr -like '*Error*') "stderr has no error message: $($run.Stderr.Trim())"
    }

    # --- files that start with a byte order mark --------------------------------------------------------------------

    # The type error is on the first line, the only line where a byte order mark can shift a column.
    $bomText = "X:int = Undefined`nMain(Args:[]string, Env:[string]string)<suspends>:void =`n    Print(`"x`")`n"
    $bomFolder = New-TestFolder 'bom' @{}
    $plainFolder = New-TestFolder 'bom-plain' @{ 'Main.verse' = $bomText }
    # The mark is written as bytes, because the script itself must stay ASCII for Windows PowerShell 5.1.
    [byte[]] $bomBytes = @(0xEF, 0xBB, 0xBF) + $Utf8NoBom.GetBytes($bomText)
    [System.IO.File]::WriteAllBytes((Join-Path $bomFolder 'Main.verse'), $bomBytes)

    # Returns the first compiler error of a run as @{ Line; Column }, both counted from 1 as printed.
    function Get-RunErrorPosition {
        param([string] $Folder)

        $run = Invoke-VerseRun -ScriptArguments @((Join-Path $Folder 'Main.verse'))
        $output = $run.Stdout + "`n" + $run.Stderr
        $match = [regex]::Match($output, '\((\d+),(\d+),\d+,\d+\):[^\r\n]*error')
        Assert-That $match.Success "The run printed no compiler error. Output: $($output.Trim())"
        return @{ Line = [int] $match.Groups[1].Value; Column = [int] $match.Groups[2].Value }
    }

    Test-Case 'a run reports an error in a file with a byte order mark at the same column as without it' {
        $withMark = Get-RunErrorPosition $bomFolder
        $without = Get-RunErrorPosition $plainFolder
        Assert-That ($withMark.Line -eq $without.Line -and $withMark.Column -eq $without.Column) `
            ("With the mark the error is at $($withMark.Line),$($withMark.Column), " +
                "without it at $($without.Line),$($without.Column).")
    }

    Test-Case 'a run reports an error at the column that check reports for a file with a byte order mark' {
        $reply = Invoke-IdeRequest (New-IdeRequestJson -Kind 'check' -Folder $bomFolder)
        Assert-ResponseOk $reply
        $errors = @(Get-Diagnostics $reply 'error')
        Assert-That ($errors.Count -ge 1) 'No error was reported by check.'
        $run = Get-RunErrorPosition $bomFolder
        # The run prints lines and columns from 1, the answer of check counts lines and UTF-8 bytes from 0.
        $match = @($errors | Where-Object {
                ($_.range.start.line + 1) -eq $run.Line -and ($_.range.start.byte + 1) -eq $run.Column
            })
        Assert-That ($match.Count -ge 1) `
            "No diagnostic of check starts at line $($run.Line), column $($run.Column) of the run."
    }

    # --- four requests at once --------------------------------------------------------------------------------------

    Test-Case 'four --ide-request processes at once all answer correctly' {
        $helloFolder = Join-Path $RepoRoot 'Samples\HelloWorld'
        $hoverPosition = Get-TextPosition $mainText 'Helper' -Delta 1
        $requests = @(
            @{ Json = '{"protocol":1,"kind":"ping"}'; Check = { param($answer) $answer.ok -eq $true } },
            @{
                Json = New-IdeRequestJson -Kind 'check' -Folder $helloFolder
                Check = {
                    param($answer)
                    $answer.ok -eq $true -and
                        @($answer.diagnostics | Where-Object { $_.severity -ne 'info' }).Count -eq 0
                }
            },
            @{
                Json = New-IdeRequestJson -Kind 'check' -Folder $semanticFolder
                Check = {
                    param($answer)
                    $answer.ok -eq $true -and
                        @($answer.diagnostics | Where-Object { $_.severity -eq 'error' }).Count -ge 1
                }
            },
            @{
                Json = New-IdeRequestJson -Kind 'hover' -Folder $hoverFolder -Target $hoverMain -Position $hoverPosition
                Check = { param($answer) $answer.ok -eq $true -and $null -ne $answer.hover }
            }
        )
        $handles = @($requests | ForEach-Object { Start-VerseProcess -Arguments '--ide-request' -Stdin $_.Json })
        $failures = @()
        for ($index = 0; $index -lt $handles.Count; $index++) {
            try {
                $result = Wait-VerseProcess $handles[$index]
                $response = ConvertTo-IdeResponse $result
                if ($result.ExitCode -ne 0 -or -not (& $requests[$index].Check $response)) {
                    $failures += "request $index was answered wrongly (exit code $($result.ExitCode))"
                }
            }
            catch {
                $failures += "request ${index}: $($_.Exception.Message)"
            }
        }
        Assert-That ($failures.Count -eq 0) ($failures -join '; ')
    }
}
finally {
    Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
if ($script:CaseFailures.Count -gt 0) {
    Write-Host "$($script:CaseFailures.Count) of $($script:CaseCount) command tests failed." -ForegroundColor Red
    exit 1
}
Write-Host "All $($script:CaseCount) command tests passed."
