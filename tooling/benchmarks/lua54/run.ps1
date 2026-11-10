param(
    [string]$RunId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'),
    [string]$EnvFile = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path '.env'),
    [string]$ExpectedStackProject = 'reamon',
    [string]$FixtureManifestPath = (Join-Path $PSScriptRoot 'fixture-manifest.json'),
    [string]$TargetArtifactVolumePath,
    [string]$ArtifactsVolume = 'reamon_artifacts',
    [string]$DerivedVolume = 'reamon_derived',
    [string]$HelperImage = 'reamon-agent',
    [string]$TestImage = 'reamon-unluac-rs-test:local',
    [string]$AnalyzerContainer = 'reamon-unluac-rs',
    [ValidateSet(0, 1)][int]$ExpectedContainsRelationships = 1,
    [string]$EvidenceOutputDirectory = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'work\benchmarks\lua54-changed-revision\runs')
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$fixtureManifest = Get-Content -LiteralPath $FixtureManifestPath -Raw | ConvertFrom-Json
$runRoot = [IO.Path]::GetFullPath($EvidenceOutputDirectory)
$targetPath = if ($TargetArtifactVolumePath) { $TargetArtifactVolumePath } else { $fixtureManifest.artifact.path }
if ($RunId -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw 'RunId must contain only letters, digits, underscores, or dashes' }
if ($targetPath -notmatch '^/data/qa/lua54-[A-Za-z0-9_-]+/fixture\.luac$') { throw 'Lua fixture path must stay under /data/qa/<fixture-id>/fixture.luac' }
if ($targetPath -ne $fixtureManifest.artifact.path) { throw 'Target artifact path differs from the enrolled fixture manifest' }
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "Compose environment file not found: $EnvFile" }
$runDirectory = Join-Path $runRoot $RunId
if (Test-Path -LiteralPath $runDirectory) { throw "Refusing to overwrite existing Lua evidence: $runDirectory" }
New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null

$testImageId = (docker image inspect $TestImage --format '{{.Id}}').Trim()
if ($LASTEXITCODE -ne 0 -or $testImageId -ne $fixtureManifest.builder.builderImageId) {
    throw 'Lua fixture test image differs from the enrolled image identity'
}
$analyzerImageId = (docker inspect $AnalyzerContainer --format '{{.Image}}').Trim()
if ($LASTEXITCODE -ne 0 -or $analyzerImageId -ne $fixtureManifest.analyzer.imageId) {
    throw 'Live unluac-rs analyzer image differs from the enrolled toolchain'
}
$containerLabels = docker inspect redamon-webapp --format '{{json .Config.Labels}}' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not identify the running webapp Compose project' }
$runningProject = $containerLabels.'com.docker.compose.project'
if ($runningProject -ne $ExpectedStackProject) { throw "Expected stack project '$ExpectedStackProject' does not match '$runningProject'" }

$sourcePath = Join-Path $repoRoot 'analyzers\unluac-rs\fixtures\lua54_behavior.lua'
$sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sourceHash -ne $fixtureManifest.groundTruth.sha256) { throw 'Lua fixture source differs from its enrollment hash' }
$targetHashLine = docker run --rm --volume "${ArtifactsVolume}:/data" --entrypoint sh $HelperImage -c "if [ -f '$targetPath' ]; then sha256sum '$targetPath'; fi"
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the enrolled Lua artifact volume' }
if (-not $targetHashLine) {
    $buildOutput = docker run --rm --user 0 --volume "${ArtifactsVolume}:/data" --entrypoint sh $TestImage -c "set -eu; mkdir -p /data/qa/lua54-unluac-rs-v1; luac5.4 -s -o '$targetPath' /app/fixtures/lua54_behavior.lua; sha256sum '$targetPath'"
    if ($LASTEXITCODE -ne 0 -or $buildOutput -notmatch $fixtureManifest.artifact.sha256) {
        throw 'Pinned Lua fixture build did not reproduce the enrolled bytecode SHA-256'
    }
    $targetHashLine = $buildOutput
}
if ($targetHashLine -notmatch $fixtureManifest.artifact.sha256) { throw 'Lua bytecode artifact differs from its enrollment hash' }

$benchmarkVariables = @(
    'REAMON_BENCHMARK_HOST_OUTPUT_DIR',
    'REAMON_BENCHMARK_FIXTURE_ID',
    'REAMON_LUA_FIXTURE_PATH',
    'REAMON_BENCHMARK_EVIDENCE_PATH',
    'REAMON_EXPECT_CONTAINS_RELATIONSHIPS'
)
$originalEnvironment = @{}
foreach ($name in $benchmarkVariables) { $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:REAMON_BENCHMARK_HOST_OUTPUT_DIR = $runRoot.Replace('\', '/')
    $env:REAMON_BENCHMARK_FIXTURE_ID = $fixtureManifest.fixtureId
    $env:REAMON_LUA_FIXTURE_PATH = '/data/reamon-artifacts' + $targetPath.Substring('/data'.Length)
    $env:REAMON_BENCHMARK_EVIDENCE_PATH = "/benchmark-output/$RunId/database-integration-evidence.json"
    $env:REAMON_EXPECT_CONTAINS_RELATIONSHIPS = [string]$ExpectedContainsRelationships
    $compose = @('compose', '-p', 'reamon-benchmark', '--project-directory', $repoRoot, '--env-file', [IO.Path]::GetFullPath($EnvFile), '-f', (Join-Path $PSScriptRoot 'docker-compose.integration.yml'), 'run', '--rm', 'benchmark-test')
    docker @compose
    if ($LASTEXITCODE -ne 0) { throw 'Lua PostgreSQL provider integration failed' }

    $databaseEvidencePath = Join-Path $runDirectory 'database-integration-evidence.json'
    if (-not (Test-Path -LiteralPath $databaseEvidencePath -PathType Leaf)) { throw 'Lua provider integration did not produce database evidence' }
    $databaseEvidence = Get-Content -LiteralPath $databaseEvidencePath -Raw | ConvertFrom-Json
    $recoveredSourcePath = Join-Path $runDirectory 'recovered.lua'
    if (-not (Test-Path -LiteralPath $recoveredSourcePath -PathType Leaf)) {
        throw 'Database integration did not preserve the source read back from the derived volume'
    }
    $recoveredSourceHash = (Get-FileHash -LiteralPath $recoveredSourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($recoveredSourceHash -ne $databaseEvidence.recoveredSourceSha256) {
        throw 'Recovered Lua source preserved from the derived volume does not match persisted evidence'
    }

    $benchmarkDirectory = (Resolve-Path $PSScriptRoot).Path
    $oracleOutput = docker run --rm --network none --memory 512m --cpus 1 --pids-limit 64 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=32m --volume "${benchmarkDirectory}:/benchmark:ro" --volume "${runDirectory}:/output:ro" --entrypoint node $TestImage /benchmark/validate_recovery.mjs /output/recovered.lua | Out-String
    if ($LASTEXITCODE -ne 0) { throw 'Bounded Lua parser/runtime oracle failed' }
    $behaviorEvidence = $oracleOutput.Trim() | ConvertFrom-Json
    if ($behaviorEvidence.recoveredSourceSha256 -ne $databaseEvidence.recoveredSourceSha256) {
        throw 'Lua runtime oracle did not consume the source saved from database evidence'
    }
    $behaviorEvidencePath = Join-Path $runDirectory 'behavior-evidence.json'
    [IO.File]::WriteAllText($behaviorEvidencePath, ($behaviorEvidence | ConvertTo-Json -Depth 10) + "`n", [Text.UTF8Encoding]::new($false))

    $mergedPath = Join-Path $runDirectory 'merged-evidence.json'
    python (Join-Path $PSScriptRoot 'merge_lua_evidence.py') --fixture-manifest $FixtureManifestPath --database-evidence $databaseEvidencePath --behavior-evidence $behaviorEvidencePath --output $mergedPath
    if ($LASTEXITCODE -ne 0) { throw 'Lua benchmark evidence merge failed' }
    Write-Output "Lua 5.4 integration evidence: $mergedPath"
}
finally {
    foreach ($name in $benchmarkVariables) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
    }
}
