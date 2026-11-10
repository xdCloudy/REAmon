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
$mutatedRuleEngine = Join-Path $mutatedRoot 'org/reamon/fixture/RuleEngine.java'
if (-not (Test-Path -LiteralPath $mutatedRuleEngine -PathType Leaf)) {
    throw 'Expected recovered fixture RuleEngine.java does not exist'
}

$sourceText = [System.IO.File]::ReadAllText($mutatedRuleEngine)
$methodPattern = '(?m)public\s+String\s+classify\s*\(\s*int\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\)\s*\{'
$methodMatches = [regex]::Matches($sourceText, $methodPattern)
if ($methodMatches.Count -ne 1) { throw 'Expected exactly one public int classify method in recovered RuleEngine.java' }
$methodMatch = $methodMatches[0]
$parameterName = $methodMatch.Groups[1].Value
$replacement = $methodMatch.Value + [Environment]::NewLine + "      if ($parameterName == 4095) { return `"mutated`"; }"
$sourceText = $sourceText.Replace($methodMatch.Value, $replacement)
[System.IO.File]::WriteAllText($mutatedRuleEngine, $sourceText, [System.Text.UTF8Encoding]::new($false))

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
if ($validatorExitCode -ne 5 -or $containerOutput -notmatch 'behavior mismatch across 8197 RuleEngine inputs') {
    throw "Expected the sampled behavior oracle to reject the changed candidate with exit 5; got exit $validatorExitCode. $containerOutput"
}
if ($containerOutput -notmatch '4095\s+high:4107' -or $containerOutput -notmatch '4095\s+mutated') {
    throw "Behavior differential did not identify the mutated input and outputs: $containerOutput"
}

$mutatedHash = (Get-FileHash -LiteralPath $mutatedRuleEngine -Algorithm SHA256).Hash.ToLowerInvariant()
$runnerHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
$validatorHash = (Get-FileHash -LiteralPath (Join-Path $fixtureRoot 'validate_recovery.sh') -Algorithm SHA256).Hash.ToLowerInvariant()
$revision = (& git -C $fixtureRoot rev-parse HEAD | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $revision) { throw 'Could not record the repository revision' }
$receipt = [ordered]@{
    schemaVersion = 1
    control = 'behavior-changing recovered-source mutation outside Main runtime examples'
    productRevision = $revision
    fixtureId = $manifest.fixtureId
    artifactSha256 = $artifactHash
    runnerSha256 = $runnerHash
    validatorSha256 = $validatorHash
    mutatedPath = 'org/reamon/fixture/RuleEngine.java'
    mutation = "Inserted a return for classify(4095) in recovered source; Main still emits the enrolled stdout."
    mutatedSourceSha256 = $mutatedHash
    oracle = '8197 sampled RuleEngine.classify integer inputs, including overflow boundaries'
    originalOutputAtMutation = 'high:4107'
    mutatedOutputAtMutation = 'mutated'
    compile = 'passed; validator proceeded to sampled behavior differential'
    validatorExitCode = $validatorExitCode
    outcome = 'REJECTED_BY_BEHAVIORAL_DIFFERENTIAL'
    scope = 'One synthetic two-class Java fixture; verifies detection at the mutated input only and is not exhaustive behavioral equivalence.'
}
$encoding = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'negative-control-receipt.json'), ($receipt | ConvertTo-Json -Depth 5), $encoding)
Write-Output "JVM sampled behavior negative control rejected as expected: input=4095; exit=$validatorExitCode"
