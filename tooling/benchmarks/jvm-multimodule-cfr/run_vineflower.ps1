param(
    [Parameter(Mandatory = $true)]
    [string]$BuildDirectory,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [string]$RunId = ("vineflower-" + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss') + "-" + [Guid]::NewGuid().ToString('N').Substring(0, 8)),
    [string]$VineflowerContainer = 'reamon-vineflower',
    [string]$ArtifactsVolume = 'reamon_artifacts',
    [string]$DerivedVolume = 'reamon_derived',
    [string]$HelperImage = 'alpine:3.20'
)

$ErrorActionPreference = 'Stop'
$fixtureRoot = $PSScriptRoot
$BuildDirectory = [System.IO.Path]::GetFullPath($BuildDirectory)
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw "Refusing existing output directory: $OutputDirectory" }
if ($RunId -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$') { throw 'RunId must be a safe Vineflower identifier' }

$manifest = Get-Content -LiteralPath (Join-Path $fixtureRoot 'manifest.json') -Raw | ConvertFrom-Json
$buildReceipt = Get-Content -LiteralPath (Join-Path $BuildDirectory 'build-receipt.json') -Raw | ConvertFrom-Json
$jarPath = Join-Path $BuildDirectory 'fixture.jar'
$jarHash = (Get-FileHash -LiteralPath $jarPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($jarHash -ne $manifest.artifact.sha256 -or $jarHash -ne $buildReceipt.artifactSha256) {
    throw 'Built JAR does not match the fixture manifest and build receipt'
}

$sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $fixtureRoot 'src') -Filter '*.java' -File -Recurse | Sort-Object FullName)
if ($sourceFiles.Count -ne $manifest.sourceModuleCount -or $sourceFiles.Count -eq 0) {
    throw 'Fixture source inventory does not match its manifest'
}
$sourcePaths = @($sourceFiles | ForEach-Object {
    $_.FullName.Substring((Join-Path $fixtureRoot 'src').Length).TrimStart('\','/') -replace '\\','/'
} | Sort-Object)
$receiptSourcePaths = @($buildReceipt.sourceSha256ByPath.PSObject.Properties.Name | Sort-Object)
if (Compare-Object $sourcePaths $receiptSourcePaths) { throw 'Build receipt source inventory differs from fixture sources' }
foreach ($source in $sourceFiles) {
    $relative = $source.FullName.Substring((Join-Path $fixtureRoot 'src').Length).TrimStart('\','/') -replace '\\','/'
    $actual = (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $buildReceipt.sourceSha256ByPath.PSObject.Properties[$relative].Value) {
        throw "Build receipt source hash differs from fixture source: $relative"
    }
}

$projectId = 'bench-jvm-vineflower'
$artifactId = 'fixture-' + $jarHash.Substring(0, 12)
$taskId = 'vineflower-fixture'
$runRoot = "$projectId/$artifactId/$taskId/$RunId"
$artifactDirectoryName = 'jvm-vineflower-' + $RunId
$artifactPath = "/data/reamon-artifacts/$artifactDirectoryName/fixture.jar"
$stagingName = 'reamon-vineflower-stage-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$copyName = 'reamon-vineflower-copy-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
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
    $python = 'import base64,sys,urllib.request; body=base64.b64decode(sys.argv[1]); req=urllib.request.Request(''http://127.0.0.1:8021/analyze'',data=body,headers={''Content-Type'':''application/json''}); print(urllib.request.urlopen(req,timeout=930).read().decode())'
    $providerText = Invoke-DockerChecked -DockerArgs @('exec', $VineflowerContainer, 'python3', '-c', $python, $requestBase64) | Out-String
    $provider = $providerText.Trim() | ConvertFrom-Json
    if ($provider.status -ne 'completed' -or $provider.artifactSha256 -ne $jarHash) {
        throw 'Vineflower did not return a completed result for the expected artifact'
    }
    $baselineUnits = @($provider.units | Where-Object { $_.sourceVariant -eq 'baseline' })
    $actualPaths = @($baselineUnits | ForEach-Object { $_.relativePath } | Sort-Object)
    if ($actualPaths.Count -ne $sourcePaths.Count -or (Compare-Object $sourcePaths $actualPaths)) {
        throw 'Vineflower baseline source inventory does not match the held-out project'
    }

    Invoke-DockerChecked -DockerArgs @('run', '-d', '--name', $copyName, '--volume', "${DerivedVolume}:/derived:ro", '--entrypoint', 'sleep', $HelperImage, '300') | Out-Null
    $localSources = Join-Path $OutputDirectory 'sources'
    New-Item -ItemType Directory -Path $localSources | Out-Null
    Invoke-DockerChecked -DockerArgs @('cp', "${copyName}:/derived/$runRoot/sources/.", $localSources) | Out-Null
    Invoke-DockerChecked -DockerArgs @('rm', '-f', $copyName) | Out-Null

    $recoveredHashes = [ordered]@{}
    foreach ($unit in $baselineUnits) {
        if ($unit.relativePath -notin $sourcePaths) { throw "Unexpected recovered source path: $($unit.relativePath)" }
        $relative = $unit.relativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar
        $localFile = Join-Path $localSources $relative
        $actualHash = (Get-FileHash -LiteralPath $localFile -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $unit.outputSha256) { throw "Recovered output hash mismatch: $($unit.relativePath)" }
        $recoveredHashes[$unit.relativePath] = $actualHash
    }

    $classNames = @($sourcePaths | ForEach-Object { ($_ -replace '\.java$','') -replace '/', '.' })
    $observed = Invoke-DockerChecked -DockerArgs @('run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--memory', '2g', '--cpus', '2', '--pids-limit', '256', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--volume', "${BuildDirectory}:/fixture:ro", '--volume', "${localSources}:/recovered-src:ro", '--volume', "${OutputDirectory}:/validation-output", '--volume', "${fixtureRoot}:/validator:ro", '--entrypoint', 'bash', $manifest.builderImage, '/validator/validate_recovery.sh', '/fixture/fixture.jar', '/recovered-src', '/validation-output', $manifest.expectedRuntimeStdout) | Out-String
    $observed = $observed.Trim()
    if ($observed -ne $manifest.expectedRuntimeStdout) { throw "Recovered runtime output mismatch: $observed" }
    $behavioralCorrespondence = Get-Content -LiteralPath (Join-Path $OutputDirectory 'behavioral-correspondence.json') -Raw | ConvertFrom-Json
    if ((-not $behavioralCorrespondence.allOutputsMatch) -or ($behavioralCorrespondence.inputCount -ne 8197) -or ($behavioralCorrespondence.originalOutputSha256 -notmatch '^[a-f0-9]{64}$') -or ($behavioralCorrespondence.originalOutputSha256 -ne $behavioralCorrespondence.recoveredOutputSha256)) {
        throw 'Container behavior probe did not verify the expected dense input set'
    }

    $classResults = [ordered]@{}
    foreach ($line in (Get-Content -LiteralPath (Join-Path $OutputDirectory 'bytecode-correspondence.tsv'))) {
        $fields = $line -split "`t"
        if ($fields.Count -ne 4 -or $fields[0] -notin $classNames -or $classResults.Contains($fields[0])) {
            throw 'Container bytecode comparison returned a malformed class record'
        }
        $classResults[$fields[0]] = [ordered]@{
            bytecodeMatch = ($fields[1] -eq 'true')
            originalJavapSha256 = $fields[2]
            recoveredJavapSha256 = $fields[3]
        }
    }
    if ($classResults.Count -ne $classNames.Count) { throw 'Bytecode comparison did not cover every expected class' }
    $matchedClasses = @($classResults.Values | Where-Object { $_.bytecodeMatch }).Count

    $serviceImage = Invoke-DockerChecked -DockerArgs @('inspect', $VineflowerContainer, '--format', '{{.Image}}') | Out-String
    $repoRevision = (& git -C $fixtureRoot rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $repoRevision) { throw 'Could not record the repository revision' }
    $runnerHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $provider | Add-Member -NotePropertyName request -NotePropertyValue ($request | ConvertFrom-Json) -Force
    $provider | Add-Member -NotePropertyName serviceContainer -NotePropertyValue $VineflowerContainer -Force
    $provider | Add-Member -NotePropertyName serviceImageId -NotePropertyValue $serviceImage.Trim() -Force
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'provider-receipt.json'), ($provider | ConvertTo-Json -Depth 14), $utf8NoBom)

    $validation = [ordered]@{
        schemaVersion = 1
        fixtureId = $manifest.fixtureId
        artifactSha256 = $jarHash
        repositoryRevision = $repoRevision
        runnerSha256 = $runnerHash
        provider = 'Vineflower ' + $provider.toolVersion
        serviceImageId = $serviceImage.Trim()
        runId = $RunId
        discoveredSourceFiles = $actualPaths.Count
        expectedSourceFiles = $sourcePaths.Count
        truncated = $provider.truncated
        recoveredSourceSha256ByPath = $recoveredHashes
        sourceCorrespondence = [ordered]@{
            method = 'javap -p -s -c exact output per class, compiled with the same pinned JDK'
            classesMatched = $matchedClasses
            classesExpected = $classNames.Count
            measurementComplete = ($classResults.Count -eq $classNames.Count)
            allClassesMatched = ($matchedClasses -eq $classNames.Count)
            classes = $classResults
        }
        compileCommand = 'javac --release 17'
        compileEnvironment = $manifest.builderImage + ' in Docker with no network and bounded resources'
        observedRuntimeStdout = $observed
        expectedRuntimeStdout = $manifest.expectedRuntimeStdout
        runtimeMatches = $true
        behavioralCorrespondence = $behavioralCorrespondence
        staticFlowCleanup = $provider.staticFlowCleanup
        claim = 'One synthetic two-class JVM fixture compiled and matched sampled RuleEngine outputs plus the observed Main stdout; javap signatures and bytecode were compared per class. This does not prove original-source equivalence or broad JVM fidelity.'
    }
    [System.IO.File]::WriteAllText((Join-Path $OutputDirectory 'validation-receipt.json'), ($validation | ConvertTo-Json -Depth 14), $utf8NoBom)
    Write-Output "Vineflower fixture passed: $RunId; sources=$($actualPaths.Count); behavior=$($behavioralCorrespondence.inputCount) inputs; bytecode=$matchedClasses/$($classNames.Count); stdout=$observed"
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
