param(
    [string]$OutputDirectory = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'work\benchmarks\pyinstaller-module-structured-source-v3')
)

$ErrorActionPreference = 'Stop'
$image = 'reamon-pyinstaller-structured-fixture:local'
$extractorImage = 'reamon-pyinstaller-fixture-extractor:local'
$artifactName = 'pyinstaller-module-structured-source'
$artifactPath = Join-Path $OutputDirectory $artifactName
$manifest = Get-Content (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
$enrollment = Get-Content (Join-Path $PSScriptRoot 'enrollment-receipt.json') -Raw | ConvertFrom-Json

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
    $actual = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) { throw "$Label hash differs from manifest: $actual" }
}

if (Test-Path -LiteralPath $OutputDirectory) { throw "Refusing existing output directory: $OutputDirectory" }
Assert-Hash (Join-Path $PSScriptRoot 'Dockerfile') $manifest.builder.dockerfileSha256 'Builder Dockerfile'
Assert-Hash (Join-Path $PSScriptRoot 'requirements.txt') $manifest.builder.requirementsSha256 'Builder requirements'
Assert-Hash (Join-Path $PSScriptRoot 'build_fixture.py') $manifest.groundTruth.sha256 'Ground truth builder'
Assert-Hash (Join-Path $PSScriptRoot $manifest.groundTruth.licenseFile) $manifest.groundTruth.licenseSha256 'Ground truth license'
if ($enrollment.fixtureId -ne $manifest.fixtureId -or
    $enrollment.extractorInventory.extractorDockerfileSha256 -ne $manifest.extractor.dockerfileSha256 -or
    $enrollment.extractorInventory.extractorServerSha256 -ne $manifest.extractor.serverSha256 -or
    $enrollment.extractorInventory.extractorUpstreamGoModSha256 -ne $manifest.extractor.upstreamGoModSha256) {
    throw 'Enrolled extractor provenance differs from the fixture manifest'
}

New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
docker build --platform linux/amd64 -t $image $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'Structured fixture image build failed' }
docker run --rm --platform linux/amd64 -v "${OutputDirectory}:/export" $image
if ($LASTEXITCODE -ne 0) { throw 'Structured fixture runtime oracle failed' }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
docker build --platform linux/amd64 -f (Join-Path $repoRoot 'analyzers/pyinstaller/Dockerfile') -t $extractorImage (Join-Path $repoRoot 'analyzers/pyinstaller')
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller extractor image build failed' }
$inventoryCheck = 'import json,server; base={"projectId":"fixture","artifactId":"structured","taskId":"enrollment","runId":"baseline","artifactPath":"/data/reamon-artifacts/pyinstaller-module-structured-source"}; pages=[server.extract({**base,"offset":offset}) for offset in (0,64,128)]; sizes=[len(page["modules"]) for page in pages]; counts=[page["moduleCount"] for page in pages]; assert counts == [180,180,180], counts; assert sizes == [64,64,52], sizes; print(json.dumps({"extractorRevision":server.EXTRACTOR_REVISION,"moduleCount":counts[0],"pageSizes":sizes}))'
$encodedCheck = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($inventoryCheck))
$pythonCheck = "exec(__import__('base64').b64decode('$encodedCheck'))"
$inventoryJson = docker run --rm --platform linux/amd64 -v "${OutputDirectory}:/data/reamon-artifacts:ro" --entrypoint python3 -w /app $extractorImage -c $pythonCheck
if ($LASTEXITCODE -ne 0) { throw 'Isolated extractor inventory did not match the declared 180 modules' }
$inventory = $inventoryJson | ConvertFrom-Json

$artifactHash = (Get-FileHash $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
$receipt = [ordered]@{
    schemaVersion = 1
    fixtureId = $manifest.fixtureId
    builtAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    platform = $manifest.target.platform
    artifactPath = $artifactName
    artifactSha256 = $artifactHash
    artifactSizeBytes = (Get-Item $artifactPath).Length
    expectedRuntimeStdout = $manifest.target.expectedRuntimeStdout
    runtimeOracle = 'PASSED in Docker build container'
    extractorImageId = (docker image inspect $extractorImage --format '{{.Id}}')
    extractorRevision = $inventory.extractorRevision
    extractorDockerfileSha256 = (Get-FileHash (Join-Path $repoRoot 'analyzers/pyinstaller/Dockerfile') -Algorithm SHA256).Hash.ToLowerInvariant()
    extractorServerSha256 = (Get-FileHash (Join-Path $repoRoot 'analyzers/pyinstaller/server.py') -Algorithm SHA256).Hash.ToLowerInvariant()
    extractorUpstreamGoModSha256 = (Get-FileHash (Join-Path $repoRoot 'analyzers/pyinstaller/upstream/go.mod') -Algorithm SHA256).Hash.ToLowerInvariant()
    extractedBytecodeModuleCount = $inventory.moduleCount
    extractedModulePageSizes = $inventory.pageSizes
    buildRunnerSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    requirementsSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'requirements.txt') -Algorithm SHA256).Hash.ToLowerInvariant()
    builderDockerfileSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'Dockerfile') -Algorithm SHA256).Hash.ToLowerInvariant()
    groundTruthBuilderSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'build_fixture.py') -Algorithm SHA256).Hash.ToLowerInvariant()
}
$receiptPath = Join-Path $OutputDirectory 'build-receipt.json'
$receipt | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $receiptPath
Get-Content -Raw $receiptPath
