param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) {
    throw "Refusing existing output directory: $OutputDirectory"
}

$image = 'reamon-jvm-multimodule-fixture:local'
$expectedOutput = 'low:-15,high:42,high:22'
$sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'src') -Filter '*.java' -File -Recurse | Sort-Object FullName)
if ($sourceFiles.Count -ne 2) { throw "Expected two independently authored Java source modules, found $($sourceFiles.Count)" }

docker build --platform linux/amd64 -t $image $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'Pinned JVM fixture image build failed' }
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$oracleScript = 'set -euo pipefail; cp /fixture.jar /out/fixture.jar; observed=$(java -jar /fixture.jar); printf "%s\n" "$observed"; test "$observed" = "' + $expectedOutput + '"'
docker run --rm --platform linux/amd64 -v "${OutputDirectory}:/out" --entrypoint bash $image -lc $oracleScript
if ($LASTEXITCODE -ne 0) { throw 'Original JAR did not pass its in-container runtime oracle' }
$jdkVersion = docker run --rm --platform linux/amd64 --entrypoint bash $image -lc 'java -version 2>&1' | Out-String
if ($LASTEXITCODE -ne 0 -or -not $jdkVersion) { throw 'Could not record the pinned JDK version' }

$sourceHashes = [ordered]@{}
foreach ($source in $sourceFiles) {
    $relative = $source.FullName.Substring((Join-Path $PSScriptRoot 'src').Length).TrimStart('\','/') -replace '\\','/'
    $sourceHashes[$relative] = (Get-FileHash -LiteralPath $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$artifactPath = Join-Path $OutputDirectory 'fixture.jar'
$receipt = [ordered]@{
    schemaVersion = 1
    fixtureId = 'jvm-multimodule-cfr-linux-amd64'
    builtAtUtc = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    platform = 'linux/amd64'
    architecture = 'x86_64'
    javaReleaseTarget = 17
    builderImage = 'eclipse-temurin:21-jdk-jammy@sha256:4b1a74fbffbe6b4e7b6f0171a472478282fb463790a51edf10e465d578f22b69'
    jdkVersion = $jdkVersion.Trim()
    sourceLicense = 'MIT'
    sourceSha256ByPath = $sourceHashes
    dockerfileSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'Dockerfile') -Algorithm SHA256).Hash.ToLowerInvariant()
    artifactPath = 'fixture.jar'
    artifactSha256 = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    artifactSizeBytes = (Get-Item -LiteralPath $artifactPath).Length
    sourceModuleCount = $sourceFiles.Count
    runtimeOracle = 'PASSED in pinned Docker image'
    expectedRuntimeStdout = $expectedOutput
    observedRuntimeStdout = $expectedOutput
    targetExecution = 'Docker only; never executed on the host'
}
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'build-receipt.json') -Encoding utf8
Get-Content -LiteralPath (Join-Path $OutputDirectory 'build-receipt.json') -Raw
