param(
    [string]$BuildOutputDirectory = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'work\benchmarks\pyinstaller-module-structured-source-v3'),
    [string]$RunId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'),
    [string]$EnvFile = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path '.env'),
    [string]$ExpectedStackProject = 'reamon',
    [string]$FixtureManifestPath,
    [string]$TargetArtifactVolumePath,
    [string]$EvidenceOutputDirectory = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'work\benchmarks\pyinstaller-module-structured-source-v3-live')
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$manifestPath = if ($FixtureManifestPath) { [IO.Path]::GetFullPath($FixtureManifestPath) } else { Join-Path $PSScriptRoot 'manifest.json' }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$outputRoot = (Resolve-Path $BuildOutputDirectory).Path
$evidenceOutputRoot = [IO.Path]::GetFullPath($EvidenceOutputDirectory)
New-Item -ItemType Directory -Force -Path $evidenceOutputRoot | Out-Null
$artifactPath = Join-Path $outputRoot $manifest.artifact.path
$targetArtifact = $TargetArtifactVolumePath
if (-not $targetArtifact) { $targetArtifact = $manifest.integration.artifactVolumePath }
if (-not $targetArtifact) { $targetArtifact = '/data/qa/pyinstaller-structured-source-v3/fixture' }
if ($targetArtifact -notmatch '^/data/qa/[A-Za-z0-9_-]+/fixture$') { throw 'Fixture volume path must stay under /data/qa/<fixture-id>/fixture' }
if ($manifest.artifact.path -notmatch '^[A-Za-z0-9._-]+$') { throw 'Fixture artifact path must be a single safe filename' }
if ($RunId -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw 'RunId must contain only letters, digits, underscores, or dashes' }
$evidencePath = Join-Path (Join-Path $evidenceOutputRoot $RunId) 'integration-evidence.json'

if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) { throw "Fixture artifact not found: $artifactPath" }
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "Compose environment file not found: $EnvFile" }
$containerLabels = docker inspect redamon-webapp --format '{{json .Config.Labels}}' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not identify the running webapp Compose project' }
$runningProject = $containerLabels.'com.docker.compose.project'
if ($runningProject -ne $ExpectedStackProject) { throw "Expected stack project '$ExpectedStackProject' does not match the running webapp project '$runningProject'" }
if (Test-Path -LiteralPath $evidencePath) { throw "Refusing to overwrite evidence: $evidencePath" }
$artifactHash = (Get-FileHash $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($artifactHash -ne $manifest.artifact.sha256) { throw "Fixture artifact hash differs from enrollment: $artifactHash" }

$volumeHash = docker run --rm -v reamon_artifacts:/data --entrypoint sh reamon-agent -c "if [ -f $targetArtifact ]; then sha256sum $targetArtifact; fi"
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the shared artifact volume' }
if ($volumeHash) {
    if ($volumeHash -notmatch $manifest.artifact.sha256) { throw "Existing artifact differs from the enrolled fixture: $targetArtifact" }
} else {
    $targetDirectory = $targetArtifact.Substring(0, $targetArtifact.LastIndexOf('/'))
    $copy = docker run --rm -v reamon_artifacts:/data -v "${outputRoot}:/fixture:ro" --entrypoint sh reamon-agent -c "set -eu; mkdir -p $targetDirectory; cp /fixture/$($manifest.artifact.path) $targetArtifact; sha256sum $targetArtifact"
    if ($LASTEXITCODE -ne 0 -or $copy -notmatch $manifest.artifact.sha256) { throw 'Could not install the enrolled fixture into the shared artifact volume' }
}

if (Test-Path -LiteralPath $evidencePath) { throw "Refusing to overwrite evidence: $evidencePath" }
$env:REAMON_BENCHMARK_HOST_OUTPUT_DIR = $evidenceOutputRoot.Replace('\', '/')
$env:REAMON_BENCHMARK_FIXTURE_ID = $manifest.fixtureId
$env:REAMON_BENCHMARK_FIXTURE_PATH = '/data/reamon-artifacts' + $targetArtifact.Substring('/data'.Length)
docker compose -p reamon-benchmark --project-directory $repoRoot --env-file $EnvFile -f (Join-Path $PSScriptRoot 'docker-compose.integration.yml') run --rm -e "REAMON_BENCHMARK_EVIDENCE_PATH=/benchmark-output/$RunId/integration-evidence.json" benchmark-test
$integrationExitCode = $LASTEXITCODE
if ($integrationExitCode -ne 0) { throw 'Structured-source PostgreSQL/worker integration failed' }
if (-not (Test-Path -LiteralPath $evidencePath -PathType Leaf)) { throw 'Integration passed without producing its evidence file' }
Write-Output "Structured-source integration evidence: $evidencePath"
