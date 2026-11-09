param(
    [string]$OutputDirectory = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'work\benchmarks\pyinstaller-module-mutated-source-control-v1')
)

$ErrorActionPreference = 'Stop'
$image = 'reamon-pyinstaller-mutated-source-fixture:local'
$extractorImage = 'reamon-pyinstaller-fixture-extractor:local'
$manifest = Get-Content (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$artifactPath = Join-Path $OutputDirectory $manifest.artifact.path

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) { throw "$Label hash differs from the manifest: $actual" }
}

if (Test-Path -LiteralPath $OutputDirectory) { throw "Refusing existing output directory: $OutputDirectory" }
Assert-Hash (Join-Path $PSScriptRoot 'Dockerfile') $manifest.builder.dockerfileSha256 'Builder Dockerfile'
Assert-Hash (Join-Path $PSScriptRoot 'requirements.txt') $manifest.builder.requirementsSha256 'Builder requirements'
Assert-Hash (Join-Path $PSScriptRoot 'build_fixture.py') $manifest.groundTruth.sha256 'Ground-truth builder'
Assert-Hash (Join-Path $PSScriptRoot $manifest.groundTruth.licenseFile) $manifest.groundTruth.licenseSha256 'Ground-truth license'

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
docker build --platform linux/amd64 -t $image $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'Mutated-source fixture image build failed' }
docker run --rm --platform linux/amd64 -v "${OutputDirectory}:/export" $image
if ($LASTEXITCODE -ne 0) { throw 'Mutated-source runtime oracle failed' }

$artifactHash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($manifest.artifact.sha256 -and $artifactHash -ne $manifest.artifact.sha256) {
    throw "Built artifact SHA-256 differs from the enrollment manifest: $artifactHash"
}
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
Assert-Hash (Join-Path $repoRoot 'analyzers/pyinstaller/Dockerfile') $manifest.extractor.dockerfileSha256 'Extractor Dockerfile'
Assert-Hash (Join-Path $repoRoot 'analyzers/pyinstaller/server.py') $manifest.extractor.serverSha256 'Extractor server'
Assert-Hash (Join-Path $repoRoot 'analyzers/pyinstaller/upstream/go.mod') $manifest.extractor.upstreamGoModSha256 'Extractor upstream go.mod'
docker build --platform linux/amd64 -f (Join-Path $repoRoot 'analyzers/pyinstaller/Dockerfile') -t $extractorImage (Join-Path $repoRoot 'analyzers/pyinstaller')
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller extractor image build failed' }

$inventoryCheck = 'import json,server; base={"projectId":"fixture","artifactId":"mutated","taskId":"enrollment","runId":"baseline","artifactPath":"/data/reamon-artifacts/' + $manifest.artifact.path + '"}; pages=[server.extract({**base,"offset":offset}) for offset in (0,64,128)]; sizes=[len(page["modules"]) for page in pages]; counts=[page["moduleCount"] for page in pages]; assert counts == [180,180,180], counts; assert sizes == [64,64,52], sizes; print(json.dumps({"extractorRevision":server.EXTRACTOR_REVISION,"moduleCount":counts[0],"pageSizes":sizes}))'
$encodedCheck = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($inventoryCheck))
$pythonCheck = "exec(__import__('base64').b64decode('$encodedCheck'))"
$inventoryJson = docker run --rm --platform linux/amd64 -v "${OutputDirectory}:/data/reamon-artifacts:ro" --entrypoint python3 -w /app $extractorImage -c $pythonCheck
if ($LASTEXITCODE -ne 0) { throw 'Isolated extractor inventory differs from the fixture contract' }
$inventory = $inventoryJson | ConvertFrom-Json

$receipt = [ordered]@{
    schemaVersion = 1
    fixtureId = $manifest.fixtureId
    builtAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    platform = $manifest.target.platform
    artifactPath = $manifest.artifact.path
    artifactSha256 = $artifactHash
    artifactSizeBytes = (Get-Item -LiteralPath $artifactPath).Length
    expectedRuntimeStdout = $manifest.target.expectedRuntimeStdout
    runtimeOracle = 'PASSED in Docker build container'
    fixtureBuilderImageId = (docker image inspect $image --format '{{.Id}}')
    extractorImageId = (docker image inspect $extractorImage --format '{{.Id}}')
    extractorRevision = $inventory.extractorRevision
    extractorDockerfileSha256 = (Get-FileHash (Join-Path $repoRoot 'analyzers/pyinstaller/Dockerfile') -Algorithm SHA256).Hash.ToLowerInvariant()
    extractorServerSha256 = (Get-FileHash (Join-Path $repoRoot 'analyzers/pyinstaller/server.py') -Algorithm SHA256).Hash.ToLowerInvariant()
    extractorUpstreamGoModSha256 = (Get-FileHash (Join-Path $repoRoot 'analyzers/pyinstaller/upstream/go.mod') -Algorithm SHA256).Hash.ToLowerInvariant()
    extractedBytecodeModuleCount = $inventory.moduleCount
    extractedModulePageSizes = $inventory.pageSizes
    requirementsSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'requirements.txt') -Algorithm SHA256).Hash.ToLowerInvariant()
    builderDockerfileSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'Dockerfile') -Algorithm SHA256).Hash.ToLowerInvariant()
    groundTruthBuilderSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'build_fixture.py') -Algorithm SHA256).Hash.ToLowerInvariant()
}
$receiptPath = Join-Path $OutputDirectory 'build-receipt.json'
$receipt | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 -LiteralPath $receiptPath
Get-Content -Raw -LiteralPath $receiptPath
