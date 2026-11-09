param(
    [Parameter(Mandatory = $true)]
    [string]$BuildDirectory,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [string]$RunId = ("cfr-" + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss') + "-" + [Guid]::NewGuid().ToString('N').Substring(0, 8)),
    [string]$CfrContainer = 'reamon-cfr',
    [string]$ArtifactsVolume = 'reamon_artifacts',
    [string]$DerivedVolume = 'reamon_derived',
    [string]$HelperImage = 'alpine:3.20'
)

$ErrorActionPreference = 'Stop'
$fixtureRoot = $PSScriptRoot
$BuildDirectory = [System.IO.Path]::GetFullPath($BuildDirectory)
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw "Refusing existing output directory: $OutputDirectory" }
if ($RunId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$') { throw 'RunId must be a safe CFR identifier' }

$manifest = Get-Content -LiteralPath (Join-Path $fixtureRoot 'manifest.json') -Raw | ConvertFrom-Json
$buildReceiptPath = Join-Path $BuildDirectory 'build-receipt.json'
$buildReceipt = Get-Content -LiteralPath $buildReceiptPath -Raw | ConvertFrom-Json
$jarPath = Join-Path $BuildDirectory 'fixture.jar'
$jarHash = (Get-FileHash -LiteralPath $jarPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($jarHash -ne $manifest.artifact.sha256 -or $jarHash -ne $buildReceipt.artifactSha256) {
    throw 'Built JAR does not match the fixture manifest and build receipt'
}

$expectedSourcePaths = @($buildReceipt.sourceSha256ByPath.PSObject.Properties.Name | Sort-Object)
if ($expectedSourcePaths.Count -ne $manifest.sourceModuleCount -or $expectedSourcePaths.Count -eq 0) {
    throw 'Build receipt source inventory does not match the fixture manifest'
}
$sourcePaths = $expectedSourcePaths

$projectId = 'bench-jvm-cfr'
$artifactId = 'fixture-' + $jarHash.Substring(0, 12)
$taskId = 'cfr-fixture'
$runRoot = "$projectId/$artifactId/$taskId/$RunId"
$artifactDirectoryName = 'jvm-cfr-' + $RunId
$artifactPath = "/data/reamon-artifacts/$artifactDirectoryName/fixture.jar"
$stagingName = 'reamon-cfr-stage-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$copyName = 'reamon-cfr-copy-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$staged = $false

function Invoke-DockerChecked {
    param([Parameter(Mandatory = $true)][string[]]$DockerArgs)
    $DockerCommand = $DockerArgs[0]
    $RemainingArgs = @($DockerArgs | Select-Object -Skip 1)
    $result = & docker $DockerCommand @RemainingArgs
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed: docker $($DockerArgs -join ' ')" }
    return $result
}

try {
    New-Item -ItemType Directory -Path $OutputDirectory | Out-Null

    # Check both shared-volume destinations before copying or asking CFR to run.
    $artifactCheck = 'test ! -e /artifacts/' + $artifactDirectoryName
    Invoke-DockerChecked -DockerArgs @('run', '--rm', '--volume', "${ArtifactsVolume}:/artifacts", '--entrypoint', 'sh', $HelperImage, '-c', $artifactCheck) | Out-Null
    $derivedCheck = 'test ! -e /derived/' + $runRoot
    Invoke-DockerChecked -DockerArgs @('run', '--rm', '--volume', "${DerivedVolume}:/derived:ro", '--entrypoint', 'sh', $HelperImage, '-c', $derivedCheck) | Out-Null

    Invoke-DockerChecked -DockerArgs @('run', '-d', '--name', $stagingName, '--volume', "${ArtifactsVolume}:/artifacts", '--entrypoint', 'sleep', $HelperImage, '300') | Out-Null
    Invoke-DockerChecked -DockerArgs @('cp', $jarPath, "${stagingName}:/tmp/fixture.jar") | Out-Null
    Invoke-DockerChecked -DockerArgs @('exec', $stagingName, 'sh', '-c', "mkdir -p /artifacts/$artifactDirectoryName && cp /tmp/fixture.jar /artifacts/$artifactDirectoryName/fixture.jar && sha256sum /artifacts/$artifactDirectoryName/fixture.jar") | Out-Null
    $staged = $true
    Invoke-DockerChecked -DockerArgs @('rm', '-f', $stagingName) | Out-Null

    $request = @{
        projectId = $projectId
        artifactId = $artifactId
        taskId = $taskId
        runId = $RunId
        artifactPath = $artifactPath
    } | ConvertTo-Json -Compress
    $requestBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($request))
    $python = 'import base64,sys,urllib.request; body=base64.b64decode(sys.argv[1]); req=urllib.request.Request(''http://127.0.0.1:8022/analyze'',data=body,headers={''Content-Type'':''application/json''}); print(urllib.request.urlopen(req,timeout=930).read().decode())'
    $providerText = Invoke-DockerChecked -DockerArgs @('exec', $CfrContainer, 'python', '-c', $python, $requestBase64) | Out-String
    $provider = $providerText.Trim() | ConvertFrom-Json
    if ($provider.status -ne 'completed' -or $provider.artifactSha256 -ne $jarHash -or $provider.truncated) {
        throw 'CFR did not return a complete result for the expected artifact'
    }
    $actualPaths = @($provider.units | ForEach-Object { $_.relativePath } | Sort-Object)
    if ($provider.sourceFileCount -ne $sourcePaths.Count -or (Compare-Object $sourcePaths $actualPaths)) {
        throw 'CFR recovered source inventory does not match the held-out project'
    }

    Invoke-DockerChecked -DockerArgs @('run', '-d', '--name', $copyName, '--volume', "${DerivedVolume}:/derived:ro", '--entrypoint', 'sleep', $HelperImage, '300') | Out-Null
    $localSources = Join-Path $OutputDirectory 'sources'
    New-Item -ItemType Directory -Path $localSources | Out-Null
    Invoke-DockerChecked -DockerArgs @('cp', "${copyName}:/derived/$runRoot/sources/.", $localSources) | Out-Null
    Invoke-DockerChecked -DockerArgs @('rm', '-f', $copyName) | Out-Null

    $recoveredHashes = [ordered]@{}
    foreach ($unit in $provider.units) {
        if ($unit.relativePath -notin $sourcePaths) { throw "Unexpected recovered source path: $($unit.relativePath)" }
        $relative = $unit.relativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar
        $localFile = Join-Path $localSources $relative
        $actualHash = (Get-FileHash -LiteralPath $localFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $unit.outputSha256) { throw "Recovered output hash mismatch: $($unit.relativePath)" }
        $recoveredHashes[$unit.relativePath] = $actualHash
    }

    $sourceArgv = @($sourcePaths | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $compileScript = 'set -euo pipefail; mkdir -p /tmp/reamon-recovered-classes; cd /data/reamon-derived/' + $runRoot + '/sources; javac --release 17 -d /tmp/reamon-recovered-classes ' + $sourceArgv + '; java -cp /tmp/reamon-recovered-classes org.reamon.fixture.Main'
    $observed = Invoke-DockerChecked -DockerArgs @('run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--memory', '2g', '--cpus', '2', '--pids-limit', '256', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--volume', "${DerivedVolume}:/data/reamon-derived:ro", '--entrypoint', 'bash', $manifest.builderImage, '-lc', $compileScript) | Out-String
    $observed = $observed.Trim()
    if ($observed -ne $manifest.expectedRuntimeStdout) { throw "Recovered runtime output mismatch: $observed" }

    $serviceImage = Invoke-DockerChecked -DockerArgs @('inspect', $CfrContainer, '--format', '{{.Image}}') | Out-String
    $repoRevision = (& git -C $fixtureRoot rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $repoRevision) { throw 'Could not record the repository revision' }
    $runnerHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $provider | Add-Member -NotePropertyName request -NotePropertyValue ($request | ConvertFrom-Json) -Force
    $provider | Add-Member -NotePropertyName serviceContainer -NotePropertyValue $CfrContainer -Force
    $provider | Add-Member -NotePropertyName serviceImageId -NotePropertyValue $serviceImage.Trim() -Force
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'provider-receipt.json'), ($provider | ConvertTo-Json -Depth 12), $utf8NoBom)
    $validation = [ordered]@{
        schemaVersion = 1
        fixtureId = $manifest.fixtureId
        artifactSha256 = $jarHash
        repositoryRevision = $repoRevision
        runnerSha256 = $runnerHash
        provider = 'CFR ' + $provider.toolVersion
        serviceImageId = $serviceImage.Trim()
        runId = $RunId
        discoveredSourceFiles = $provider.sourceFileCount
        expectedSourceFiles = $sourcePaths.Count
        truncated = $provider.truncated
        recoveredSourceSha256ByPath = $recoveredHashes
        compileCommand = 'javac --release 17'
        compileEnvironment = $manifest.builderImage + ' in Docker with no network and bounded resources'
        observedRuntimeStdout = $observed
        expectedRuntimeStdout = $manifest.expectedRuntimeStdout
        runtimeMatches = $true
        claim = 'One synthetic two-class JVM fixture compiled and ran with matching observed stdout; this is not proof of original-source equivalence or broad JVM fidelity.'
    }
    [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'validation-receipt.json'), ($validation | ConvertTo-Json -Depth 12), $utf8NoBom)
    Write-Output "CFR fixture passed: $RunId; sources=$($sourcePaths.Count); stdout=$observed"
}
finally {
    docker rm -f $stagingName 2>$null | Out-Null
    docker rm -f $copyName 2>$null | Out-Null
    if ($staged) {
        $stagedJar = "/artifacts/$artifactDirectoryName/fixture.jar"
        $stagedHash = (Invoke-DockerChecked -DockerArgs @('run', '--rm', '--volume', "${ArtifactsVolume}:/artifacts", $HelperImage, 'sha256sum', $stagedJar) | Out-String).Trim().Split(' ')[0]
        if ($stagedHash -ne $jarHash) { throw "Refusing to clean staged artifact with unexpected hash: $stagedHash" }
        Invoke-DockerChecked -DockerArgs @('run', '--rm', '--volume', "${ArtifactsVolume}:/artifacts", $HelperImage, 'rm', '--', $stagedJar) | Out-Null
        Invoke-DockerChecked -DockerArgs @('run', '--rm', '--volume', "${ArtifactsVolume}:/artifacts", $HelperImage, 'rmdir', '--', "/artifacts/$artifactDirectoryName") | Out-Null
    }
}
