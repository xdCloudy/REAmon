param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [string]$ExtractorImage = 'reamon-pyinstaller-embedded-nul-control:local'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw "Refusing existing output directory: $OutputDirectory" }
$manifest = Get-Content (Join-Path $PSScriptRoot 'manifest-embedded-nul-name.json') -Raw | ConvertFrom-Json
$fixtureDirectory = Join-Path $OutputDirectory 'fixture'
$fixtureArtifact = Join-Path $fixtureDirectory 'pyinstaller-module-structured-source'
$malformedArtifact = Join-Path $OutputDirectory 'embedded-nul-name'
$mutationReceipt = Join-Path $OutputDirectory 'mutation-receipt.json'
$preflightReceipt = Join-Path $OutputDirectory 'preflight-receipt.json'
$providerReceipt = Join-Path $OutputDirectory 'provider-receipt.json'
$fixtureScript = Join-Path $repoRoot 'tooling/benchmarks/pyinstaller-module-structured-source/build.ps1'
$mutator = Join-Path $PSScriptRoot 'mutate_carchive.py'
$toolsMount = "${PSScriptRoot}:/tools:ro"
$serviceName = "reamon-pyi-nul-$([guid]::NewGuid().ToString('N').Substring(0,12))"
$serviceStarted = $false

New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
try {
    & $fixtureScript -OutputDirectory $fixtureDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Pinned clean fixture build or its baseline oracle failed' }
    if (-not (Test-Path -LiteralPath $fixtureArtifact -PathType Leaf)) { throw 'Pinned fixture artifact is missing' }

    docker run --rm --network none `
        -v "${repoRoot}:/repo:ro" `
        -v "${OutputDirectory}:/control" `
        --entrypoint python python:3.12.8-slim-bookworm@sha256:2199a62885a12290dc9c5be3ca0681d367576ab7bf037da120e564723292a2f0 `
        /repo/tooling/benchmarks/pyinstaller-malformed-carchive-control/mutate_carchive.py `
        --input /control/fixture/pyinstaller-module-structured-source `
        --output /control/embedded-nul-name `
        --receipt /control/mutation-receipt.json `
        --mutation first-entry-embedded-nul-name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the hash-bound embedded-NUL artifact' }

    $mutation = Get-Content -LiteralPath $mutationReceipt -Raw | ConvertFrom-Json
    if ($mutation.fixtureId -ne $manifest.fixtureId -or $mutation.mutationId -ne 'first-entry-embedded-nul-name') {
        throw 'Mutation receipt does not identify the embedded-NUL name control'
    }
    $artifactHash = (Get-FileHash -LiteralPath $malformedArtifact -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($mutation.malformedArtifact.sha256 -ne $artifactHash) { throw 'Malformed artifact differs from its mutation receipt' }

    docker build --platform linux/amd64 -f (Join-Path $repoRoot 'analyzers/pyinstaller/Dockerfile') -t $ExtractorImage (Join-Path $repoRoot 'analyzers/pyinstaller') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller extractor image build failed' }
    $imageId = docker image inspect --format '{{.Id}}' $ExtractorImage
    if ($LASTEXITCODE -ne 0 -or -not $imageId) { throw 'Could not identify the tested extractor image' }

    docker run -d --network none --name $serviceName `
        -v "${OutputDirectory}:/data/reamon-artifacts:ro" `
        $ExtractorImage | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the isolated PyInstaller service' }
    $serviceStarted = $true
    Start-Sleep -Seconds 2

    docker run --rm --network none `
        -v "${OutputDirectory}:/data/reamon-artifacts:ro" `
        -v $toolsMount `
        -v "${OutputDirectory}:/control" `
        -w /app `
        --entrypoint python3 $ExtractorImage /tools/preflight.py `
        --artifact-path /data/reamon-artifacts/embedded-nul-name `
        --artifact-sha256 $artifactHash `
        --fixture-id $manifest.fixtureId `
        --service-image-id $imageId `
        --output /control/preflight-receipt.json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The malformed artifact did not pass the service cookie preflight' }

    docker run --rm --network "container:$serviceName" `
        -v "${OutputDirectory}:/control" `
        -v "${OutputDirectory}:/data/reamon-artifacts:ro" `
        -v $toolsMount `
        --entrypoint python python:3.12.8-slim-bookworm@sha256:2199a62885a12290dc9c5be3ca0681d367576ab7bf037da120e564723292a2f0 `
        /tools/probe_endpoint.py `
        --base-url http://127.0.0.1:8029 `
        --artifact-path /data/reamon-artifacts/embedded-nul-name `
        --artifact-sha256 $artifactHash `
        --fixture-id $manifest.fixtureId `
        --artifact-id embedded-nul-v1 `
        --project-id malformed-name-control `
        --run-id embedded-nul-v1 `
        --expected-http-status $manifest.expectedProviderOutcome.httpStatus `
        --expected-status $manifest.expectedProviderOutcome.status `
        --output /control/provider-receipt.json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Isolated analyzer did not reject the embedded-NUL name with the expected response' }

    $provider = Get-Content -LiteralPath $providerReceipt -Raw | ConvertFrom-Json
    $preflight = Get-Content -LiteralPath $preflightReceipt -Raw | ConvertFrom-Json
    if ($provider.controlResult -ne 'PASS' -or $provider.response.httpStatus -ne 400 -or -not $preflight.cookieAccepted) {
        throw 'Provider receipt does not satisfy the embedded-NUL rejection contract'
    }
    [pscustomobject]@{
        fixtureId = $manifest.fixtureId
        sourceArtifactSha256 = $mutation.sourceArtifact.sha256
        malformedArtifactSha256 = $artifactHash
        cookieAccepted = $true
        httpStatus = $provider.response.httpStatus
        status = $provider.response.body.status
        extractorRevision = $provider.service.extractorRevision
        extractorImageId = $imageId
        mutationReceipt = $mutationReceipt
        providerReceipt = $providerReceipt
    } | ConvertTo-Json -Compress
}
finally {
    if ($serviceStarted) {
        docker rm -f $serviceName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove the isolated analyzer container' }
    }
}
