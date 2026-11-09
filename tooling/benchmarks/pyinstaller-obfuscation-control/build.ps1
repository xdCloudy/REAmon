param(
    [string]$OutputDirectory = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'work\benchmarks\pyinstaller-obfuscation-control-20261109')
)

$ErrorActionPreference = 'Stop'
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$image = 'reamon-pyinstaller-obfuscation-fixture:local'
$manifest = Get-Content (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
    $actual = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected) { throw "$Label hash differs from manifest: $actual" }
}

if (Test-Path -LiteralPath $OutputDirectory) { throw "Refusing existing output directory: $OutputDirectory" }
Assert-Hash (Join-Path $PSScriptRoot 'Dockerfile') $manifest.builder.dockerfileSha256 'Builder Dockerfile'
Assert-Hash (Join-Path $PSScriptRoot 'requirements.txt') $manifest.builder.requirementsSha256 'Builder requirements'
Assert-Hash (Join-Path $PSScriptRoot 'build_fixture.py') $manifest.builder.sourceSha256 'Fixture builder'
Assert-Hash (Join-Path $PSScriptRoot 'test_fixture.py') $manifest.builder.testSha256 'Fixture tests'
Assert-Hash (Join-Path $PSScriptRoot 'probe_endpoint.py') $manifest.builder.probeSha256 'Live provider probe'
Assert-Hash (Join-Path $PSScriptRoot 'build.ps1') $manifest.builder.buildScriptSha256 'Build script'
Assert-Hash (Join-Path $PSScriptRoot 'run-control.ps1') $manifest.builder.runScriptSha256 'Live runner'

New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
docker build --platform linux/amd64 -t $image $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'Obfuscation fixture image build failed' }
docker run --rm --platform linux/amd64 -v "${OutputDirectory}:/export" $image
if ($LASTEXITCODE -ne 0) { throw 'Clean or obfuscated fixture runtime oracle failed' }

$artifacts = @{}
foreach ($name in @('pyinstaller-obfuscation-clean', 'pyinstaller-obfuscation-obfuscated')) {
    $path = Join-Path $OutputDirectory $name
    $artifacts[$name] = @{
        sha256 = (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
        sizeBytes = (Get-Item $path).Length
    }
}
$receipt = [ordered]@{
    schemaVersion = 1
    fixtureId = $manifest.fixtureId
    builtAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    platform = $manifest.platform
    expectedRuntimeStdout = $manifest.groundTruth.runtimeStdout
    runtimeOracle = 'Both artifacts passed identical branch and stdout assertions inside Docker.'
    artifacts = $artifacts
    builderImageId = (docker image inspect $image --format '{{.Id}}')
    builderDockerfileSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'Dockerfile') -Algorithm SHA256).Hash.ToLowerInvariant()
    builderRequirementsSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'requirements.txt') -Algorithm SHA256).Hash.ToLowerInvariant()
    fixtureBuilderSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'build_fixture.py') -Algorithm SHA256).Hash.ToLowerInvariant()
    fixtureTestSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'test_fixture.py') -Algorithm SHA256).Hash.ToLowerInvariant()
    providerProbeSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'probe_endpoint.py') -Algorithm SHA256).Hash.ToLowerInvariant()
    buildScriptSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'build.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    liveRunnerSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'run-control.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    manifestSha256 = (Get-FileHash (Join-Path $PSScriptRoot 'manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
}
$receiptPath = Join-Path $OutputDirectory 'build-receipt.json'
$receipt | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $receiptPath
Get-Content -Raw $receiptPath
