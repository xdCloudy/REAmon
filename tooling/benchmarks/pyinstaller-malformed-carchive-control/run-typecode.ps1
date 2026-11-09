param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactPath,
    [Parameter(Mandatory = $true)]
    [string]$MutationReceiptPath,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$ArtifactPath = (Resolve-Path -LiteralPath $ArtifactPath).Path
$MutationReceiptPath = (Resolve-Path -LiteralPath $MutationReceiptPath).Path
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$manifest = Get-Content (Join-Path $PSScriptRoot 'manifest-typecode.json') -Raw | ConvertFrom-Json
$mutation = Get-Content $MutationReceiptPath -Raw | ConvertFrom-Json
$artifactHash = (Get-FileHash $ArtifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($mutation.fixtureId -ne $manifest.fixtureId -or $mutation.mutationId -ne 'first-entry-invalid-typecode') {
    throw 'Mutation receipt does not identify the invalid CArchive entry-typecode control'
}
if ($mutation.malformedArtifact.sha256 -ne $artifactHash) { throw 'Artifact hash differs from mutation receipt' }

$pythonImage = 'python:3.12.8-slim-bookworm@sha256:2199a62885a12290dc9c5be3ca0681d367576ab7bf037da120e564723292a2f0'
$serviceName = 'reamon-pyinstaller'
$serviceImage = docker inspect --format '{{.Config.Image}}' $serviceName
$serviceImageId = docker inspect --format '{{.Image}}' $serviceName
if ($LASTEXITCODE -ne 0 -or -not $serviceImage -or -not $serviceImageId) { throw 'Running PyInstaller service was not found' }

New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$stageId = Get-Date -Format 'yyyyMMddTHHmmss'
$stagingReceiptPath = Join-Path $OutputDirectory "staging-receipt-$stageId.json"
$preflightReceiptPath = Join-Path $OutputDirectory "preflight-receipt-$stageId.json"
$providerReceiptPath = Join-Path $OutputDirectory "provider-receipt-$stageId.json"
foreach ($path in @($stagingReceiptPath, $preflightReceiptPath, $providerReceiptPath)) {
    if (Test-Path -LiteralPath $path) { throw "Refusing existing receipt: $path" }
}
$stagedArtifactPath = "/data/reamon-artifacts/qa/pyinstaller-malformed-$stageId/fixture"
$toolMount = "${PSScriptRoot}:/tools:ro"
$evidenceMount = "${OutputDirectory}:/evidence"
$staged = $false

try {
    docker run --rm `
        -v reamon_artifacts:/data/reamon-artifacts `
        -v "${ArtifactPath}:/input/fixture:ro" `
        -v "${MutationReceiptPath}:/input/mutation.json:ro" `
        -v $toolMount `
        -v $evidenceMount `
        --entrypoint python $pythonImage /tools/stage_artifact.py stage `
        --source /input/fixture `
        --mutation-receipt /input/mutation.json `
        --stage-id $stageId `
        --fixture-id $manifest.fixtureId `
        --output "/evidence/staging-receipt-$stageId.json" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not stage the hash-verified malformed artifact' }
    $staged = $true

    docker run --rm `
        -v reamon_artifacts:/data/reamon-artifacts:ro `
        -v $toolMount `
        -v $evidenceMount `
        -w /app `
        --entrypoint python3 $serviceImage /tools/preflight.py `
        --artifact-path $stagedArtifactPath `
        --artifact-sha256 $artifactHash `
        --fixture-id $manifest.fixtureId `
        --service-image-id $serviceImageId `
        --output "/evidence/preflight-receipt-$stageId.json" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Service-image cookie preflight failed' }

    docker run --rm --network container:reamon-pyinstaller `
        -v reamon_artifacts:/data/reamon-artifacts:ro `
        -v $toolMount `
        -v $evidenceMount `
        --entrypoint python $pythonImage /tools/probe_endpoint.py `
        --base-url http://127.0.0.1:8029 `
        --artifact-path $stagedArtifactPath `
        --artifact-sha256 $artifactHash `
        --fixture-id $manifest.fixtureId `
        --artifact-id typecode-v1 `
        --project-id malformed-typecode-control `
        --run-id "typecode-$stageId" `
        --expected-http-status $manifest.expectedProviderOutcome.httpStatus `
        --expected-status $manifest.expectedProviderOutcome.status `
        --expected-module-count $manifest.expectedProviderOutcome.moduleCount `
        --output "/evidence/provider-receipt-$stageId.json" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Live provider did not meet the malformed-control rejection contract' }
}
finally {
    if ($staged) {
        docker run --rm `
            -v reamon_artifacts:/data/reamon-artifacts `
            -v $toolMount `
            -v $evidenceMount `
            --entrypoint python $pythonImage /tools/stage_artifact.py cleanup `
            --receipt "/evidence/staging-receipt-$stageId.json" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Hash-verified cleanup failed; staged artifact was preserved' }
    }
}

$preflight = Get-Content $preflightReceiptPath -Raw | ConvertFrom-Json
$provider = Get-Content $providerReceiptPath -Raw | ConvertFrom-Json
$staging = Get-Content $stagingReceiptPath -Raw | ConvertFrom-Json
if (-not $preflight.cookieAccepted -or $provider.controlResult -ne 'PASS' -or $staging.cleanup -ne 'REMOVED_AFTER_HASH_CHECK') {
    throw 'Malformed-control evidence is incomplete or failed'
}
[pscustomobject]@{
    fixtureId = $manifest.fixtureId
    artifactSha256 = $artifactHash
    cookieAccepted = $preflight.cookieAccepted
    httpStatus = $provider.response.httpStatus
    status = $provider.response.body.status
    cleanup = $staging.cleanup
    serviceImageId = $serviceImageId
    extractorRevision = $provider.service.extractorRevision
    preflightReceipt = $preflightReceiptPath
    providerReceipt = $providerReceiptPath
    stagingReceipt = $stagingReceiptPath
} | ConvertTo-Json -Compress
