param(
    [string]$OutputDirectory = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path 'work\benchmarks\pyinstaller-obfuscation-control-20261109')
)

$ErrorActionPreference = 'Stop'
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$image = 'reamon-pyinstaller-obfuscation-fixture:local'
$buildReceiptPath = Join-Path $OutputDirectory 'build-receipt.json'
$receiptPath = Join-Path $OutputDirectory 'provider-receipt.json'
if (-not (Test-Path -LiteralPath $buildReceiptPath)) { throw 'Build receipt is missing; run build.ps1 first' }
if (Test-Path -LiteralPath $receiptPath) { throw "Refusing existing provider receipt: $receiptPath" }
$serviceImageId = docker inspect --format '{{.Image}}' reamon-pyinstaller
if ($LASTEXITCODE -ne 0 -or -not $serviceImageId) { throw 'Running PyInstaller service was not found' }
$stageId = Get-Date -Format 'yyyyMMddTHHmmss'

docker run --rm --platform linux/amd64 `
    --network container:reamon-pyinstaller `
    -v reamon_artifacts:/data/reamon-artifacts `
    -v "${OutputDirectory}:/fixtures" `
    --entrypoint python $image /fixture/probe_endpoint.py `
    --build-receipt /fixtures/build-receipt.json `
    --clean-artifact /fixtures/pyinstaller-obfuscation-clean `
    --obfuscated-artifact /fixtures/pyinstaller-obfuscation-obfuscated `
    --service-image-id $serviceImageId `
    --stage-id $stageId `
    --output /fixtures/provider-receipt.json
if ($LASTEXITCODE -ne 0) { throw 'Live clean/obfuscated provider comparison failed' }
Get-Content -Raw $receiptPath
