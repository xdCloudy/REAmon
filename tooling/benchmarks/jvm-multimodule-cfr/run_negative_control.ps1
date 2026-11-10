param(
    [Parameter(Mandatory = $true)]
    [string]$BuildDirectory,
    [Parameter(Mandatory = $true)]
    [string]$SourceDirectory,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$fixtureRoot = $PSScriptRoot
$BuildDirectory = [System.IO.Path]::GetFullPath($BuildDirectory)
$SourceDirectory = [System.IO.Path]::GetFullPath($SourceDirectory)
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw "Refusing existing output directory: $OutputDirectory" }
if (-not (Test-Path -LiteralPath (Join-Path $BuildDirectory 'fixture.jar') -PathType Leaf)) {
    throw "Fixture JAR is missing from build directory: $BuildDirectory"
}
if (-not (Test-Path -LiteralPath $SourceDirectory -PathType Container)) {
    throw "Recovered source directory does not exist: $SourceDirectory"
}

$manifest = Get-Content -LiteralPath (Join-Path $fixtureRoot 'manifest.json') -Raw | ConvertFrom-Json
$artifactHash = (Get-FileHash -LiteralPath (Join-Path $BuildDirectory 'fixture.jar') -Algorithm SHA256).Hash.ToLowerInvariant()
if ($artifactHash -ne $manifest.artifact.sha256) { throw 'Built JAR does not match the enrolled fixture manifest' }
$mutatedRoot = Join-Path $OutputDirectory 'mutated-sources'
$validationOutput = Join-Path $OutputDirectory 'validation-output'
New-Item -ItemType Directory -Path $OutputDirectory,$mutatedRoot,$validationOutput | Out-Null
Copy-Item -Path (Join-Path $SourceDirectory '*') -Destination $mutatedRoot -Recurse

$mutatedMain = Join-Path $mutatedRoot 'org/reamon/fixture/Main.java'
if (-not (Test-Path -LiteralPath $mutatedMain -PathType Leaf)) {
    throw 'Expected recovered fixture Main.java does not exist'
}
$sourceText = [System.IO.File]::ReadAllText($mutatedMain)
$mutation = 'classify(30)'
if ([regex]::Matches($sourceText, [regex]::Escape($mutation)).Count -ne 1) {
    throw 'Expected exactly one classify(30) mutation point in recovered Main.java'
}
$sourceText = $sourceText.Replace($mutation, 'classify(300)')
[System.IO.File]::WriteAllText($mutatedMain, $sourceText, [System.Text.UTF8Encoding]::new($false))

$dockerArgs = @(
    'run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--memory', '2g',
    '--cpus', '2', '--pids-limit', '256', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--volume', "${BuildDirectory}:/fixture:ro",
    '--volume', "${mutatedRoot}:/recovered-src:ro",
    '--volume', "${validationOutput}:/validation-output",
    '--volume', "${fixtureRoot}:/validator:ro",
    '--entrypoint', 'bash', $manifest.builderImage,
    '/validator/validate_recovery.sh', '/fixture/fixture.jar', '/recovered-src',
    '/validation-output', $manifest.expectedRuntimeStdout
)
$savedErrorActionPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$containerLines = & docker @dockerArgs 2>&1
$validatorExitCode = $LASTEXITCODE
$ErrorActionPreference = $savedErrorActionPreference
$containerOutput = $containerLines | Out-String
if ($validatorExitCode -ne 4 -or $containerOutput -notmatch 'runtime output mismatch:') {
    throw "Expected the runtime oracle to reject the changed candidate with exit 4; got exit $validatorExitCode. $containerOutput"
}
$outputMatch = [regex]::Match($containerOutput, 'observed\s+([^\r\n;]+)')
if (-not $outputMatch.Success) {
    throw "Could not read observed output from validator response: $containerOutput"
}
$observedStdout = $outputMatch.Groups[1].Value.Trim()
$expectedStdout = $manifest.expectedRuntimeStdout
$mutatedHash = (Get-FileHash -LiteralPath $mutatedMain -Algorithm SHA256).Hash.ToLowerInvariant()
$runnerHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$validatorHash = (Get-FileHash -LiteralPath (Join-Path $fixtureRoot 'validate_recovery.sh') -Algorithm SHA256).Hash.ToLowerInvariant()
$revision = (& git -C $fixtureRoot rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $revision) { throw 'Could not record the repository revision' }
$receipt = [ordered]@{
    schemaVersion = 1
    control = 'behavior-changing recovered-source mutation'
    productRevision = $revision
    fixtureId = $manifest.fixtureId
    artifactSha256 = $artifactHash
    runnerSha256 = $runnerHash
    validatorSha256 = $validatorHash
    mutatedPath = 'org/reamon/fixture/Main.java'
    mutation = "Changed $mutation to classify(300) in recovered source"
    mutatedSourceSha256 = $mutatedHash
    expectedRuntimeStdout = $expectedStdout
    observedRuntimeStdout = $observedStdout
    compile = 'passed; validator proceeded to runtime check'
    validatorExitCode = $validatorExitCode
    outcome = 'REJECTED_BY_RUNTIME_ORACLE'
    scope = 'One synthetic two-class Java fixture; verifies this oracle rejects this behavior-changing candidate only.'
}
$encoding = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'negative-control-receipt.json'), ($receipt | ConvertTo-Json -Depth 5), $encoding)
Write-Output "JVM negative control rejected as expected: exit=$validatorExitCode; stdout=$observedStdout"
