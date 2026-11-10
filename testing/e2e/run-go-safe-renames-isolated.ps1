$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$webappContext = Join-Path $repoRoot 'webapp'
$e2eDirectory = $PSScriptRoot
$runId = [Guid]::NewGuid().ToString('N').Substring(0, 10)
$networkName = "reamon-go-rename-e2e-$runId"
$databaseName = "reamon-go-rename-db-$runId"
$appName = "reamon-go-rename-app-$runId"
$imageName = "reamon-go-rename-e2e:$runId"
$authSecret = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$wsTicketSecret = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$previousBaseUrl = $env:REDAMON_BASE_URL
$previousAuthSecret = $env:REDAMON_E2E_AUTH_SECRET
$listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$baseUrl = "http://127.0.0.1:$port"

function Invoke-DockerArray {
  param([string[]]$DockerArguments)
  & docker @DockerArguments
  if ($LASTEXITCODE -ne 0) { throw "docker $($DockerArguments -join ' ') failed with exit code $LASTEXITCODE" }
}

try {
  Invoke-DockerArray @('build', '-f', (Join-Path $webappContext 'Dockerfile'), '-t', $imageName, '--build-arg', 'REAMON_BUILD_SHA=e2e-local', '--build-arg', 'REAMON_VERSION=e2e-local', $webappContext)
  Invoke-DockerArray @('network', 'create', $networkName) | Out-Null
  Invoke-DockerArray @('run', '-d', '--name', $databaseName, '--network', $networkName, '-e', 'POSTGRES_USER=e2e', '-e', 'POSTGRES_PASSWORD=e2e-only-test', '-e', 'POSTGRES_DB=reamon_e2e', 'postgres:16-alpine') | Out-Null

  $databaseReady = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    & docker exec $databaseName pg_isready -U e2e -d reamon_e2e *> $null
    if ($LASTEXITCODE -eq 0) { $databaseReady = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $databaseReady) { throw 'The isolated PostgreSQL container did not become ready.' }

  $databaseUrl = "DATABASE_URL=postgresql://e2e:e2e-only-test@${databaseName}:5432/reamon_e2e"
  Invoke-DockerArray @('run', '-d', '--name', $appName, '--network', $networkName, '-p', "127.0.0.1:${port}:3000", '-e', $databaseUrl, '-e', "AUTH_SECRET=$authSecret", '-e', "AGENT_WS_TICKET_SECRET=$wsTicketSecret", '-e', 'NODE_ENV=production', $imageName) | Out-Null

  $appReady = $false
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    if ((& docker inspect --format '{{.State.Running}}' $appName 2>$null) -ne 'true') { break }
    $status = & curl.exe --silent --output NUL --write-out '%{http_code}' "$baseUrl/login" 2>$null
    if ($status -match '^[1-5]\d\d$' -and $status -ne '000') { $appReady = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $appReady) { throw 'The isolated webapp did not become ready.' }

  Push-Location $e2eDirectory
  try {
    if (-not (Test-Path 'node_modules/@playwright/test')) {
      & npm ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    }
    & npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "Playwright Chromium install failed with exit code $LASTEXITCODE" }
    $env:REDAMON_BASE_URL = $baseUrl
    $env:REDAMON_E2E_AUTH_SECRET = $authSecret
    & npx playwright test goSafeRenamesBrowser.spec.ts
    if ($LASTEXITCODE -ne 0) { throw "Playwright browser acceptance failed with exit code $LASTEXITCODE" }
  } finally {
    if ($null -eq $previousBaseUrl) { Remove-Item Env:\REDAMON_BASE_URL -ErrorAction SilentlyContinue } else { $env:REDAMON_BASE_URL = $previousBaseUrl }
    if ($null -eq $previousAuthSecret) { Remove-Item Env:\REDAMON_E2E_AUTH_SECRET -ErrorAction SilentlyContinue } else { $env:REDAMON_E2E_AUTH_SECRET = $previousAuthSecret }
    Pop-Location
  }
} finally {
  & docker rm -f $appName 2>$null | Out-Null
  & docker rm -f $databaseName 2>$null | Out-Null
  & docker network rm $networkName 2>$null | Out-Null
  & docker image rm $imageName 2>$null | Out-Null
}
