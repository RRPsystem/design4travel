# scripts/run-spike.ps1
#
# End-to-end driver voor de spike: doet prepare + build achter elkaar en geeft
# het sandbox_id automatisch door. Elke phase is een POST binnen Supabase's
# 150s IDLE_TIMEOUT.
#
# Gebruik:
#   .\scripts\run-spike.ps1 -AnonKey "sb_publishable_..." -ArchivePath "spike-sandbox-target-<stamp>.tar.gz"

param(
  [Parameter(Mandatory=$true)]
  [string]$AnonKey,

  [Parameter(Mandatory=$true)]
  [string]$ArchivePath,

  [string]$ProjectRef = "ltzzxjrnhfcilfplpoep",

  # Als aanwezig: capture-phase kilt de sandbox NIET, zodat preview-host
  # er via phase="expose" naar kan connecten. Vergeet niet later handmatig
  # via phase="destroy" te killen (of E2B doet dat na 30min timeout).
  [switch]$KeepAlive
)

$ErrorActionPreference = "Stop"
$baseUrl = "https://$ProjectRef.supabase.co/functions/v1/sandbox-build-trigger"
$headers = @{
  "Authorization" = "Bearer $AnonKey"
  "Content-Type"  = "application/json"
}

function Post-Phase {
  param([string]$Body)
  try {
    return Invoke-RestMethod -Method POST -Uri $baseUrl -Headers $headers -Body $Body -TimeoutSec 200
  } catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $b = $reader.ReadToEnd()
        Write-Host "Response body: $b" -ForegroundColor Red
      } catch {}
    }
    return $null
  }
}

# ---- PHASE 1: PREPARE ----
Write-Host ""
Write-Host "=== PHASE 1: PREPARE ===" -ForegroundColor Cyan
Write-Host "Sandbox aanmaken + apt-libs + Playwright + Chromium ..."
Write-Host "(dit duurt normaal 60-120s)"
$prepareBody = ConvertTo-Json @{ phase = "prepare" } -Compress
$prepare = Post-Phase -Body $prepareBody

if ($null -eq $prepare) {
  Write-Host "PREPARE faalde met HTTP-fout. Stop." -ForegroundColor Red
  exit 1
}

$prepare | ConvertTo-Json -Depth 20 | Write-Host

if (-not $prepare.ok -or -not $prepare.sandbox_id) {
  Write-Host ""
  Write-Host "PREPARE niet OK. Zie logs hierboven." -ForegroundColor Red
  exit 1
}

$sandboxId = $prepare.sandbox_id
Write-Host ""
Write-Host "PREPARE OK. sandbox_id = $sandboxId (duur $($prepare.duration_total_ms)ms)" -ForegroundColor Green

# ---- PHASE 2: BUILD ----
Write-Host ""
Write-Host "=== PHASE 2: BUILD ===" -ForegroundColor Cyan
Write-Host "Download archive + npm install + vite build ..."
Write-Host "(dit duurt normaal 20-40s)"
$buildBody = ConvertTo-Json @{
  phase        = "build"
  sandbox_id   = $sandboxId
  archive_path = $ArchivePath
} -Compress
$build = Post-Phase -Body $buildBody

if ($null -eq $build) {
  Write-Host "BUILD faalde met HTTP-fout. Stop." -ForegroundColor Red
  exit 1
}

$build | ConvertTo-Json -Depth 20 | Write-Host

if (-not $build.ok) {
  Write-Host ""
  Write-Host "BUILD niet OK. Error: $($build.error)" -ForegroundColor Red
  Write-Host "Zie logs hierboven voor de crashende stap." -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "BUILD OK. (duur $($build.duration_total_ms)ms)" -ForegroundColor Green

# ---- PHASE 3: CAPTURE ----
Write-Host ""
Write-Host "=== PHASE 3: CAPTURE ===" -ForegroundColor Cyan
Write-Host "Serve dist + Chromium screenshot desktop+mobile + upload naar Storage ..."
Write-Host "(dit duurt normaal 40-90s)"
$captureBody = ConvertTo-Json @{
  phase      = "capture"
  sandbox_id = $sandboxId
  keep_alive = [bool]$KeepAlive
} -Compress
$capture = Post-Phase -Body $captureBody

if ($null -eq $capture) {
  Write-Host "CAPTURE faalde met HTTP-fout. Stop." -ForegroundColor Red
  exit 1
}

$capture | ConvertTo-Json -Depth 20 | Write-Host

Write-Host ""
Write-Host "=== SAMENVATTING ===" -ForegroundColor Yellow

if ($capture.ok -and $capture.screenshots) {
  Write-Host "SPIKE END-TO-END GESLAAGD." -ForegroundColor Green
  Write-Host ""
  Write-Host "Desktop screenshot:" -ForegroundColor Green
  Write-Host "  $($capture.screenshots.desktop_signed_url)"
  Write-Host "Mobile screenshot:" -ForegroundColor Green
  Write-Host "  $($capture.screenshots.mobile_signed_url)"
  Write-Host ""
  Write-Host "Totalen: prepare $($prepare.duration_total_ms)ms + build $($build.duration_total_ms)ms + capture $($capture.duration_total_ms)ms" -ForegroundColor Gray
  if ($KeepAlive) {
    Write-Host ""
    Write-Host "Sandbox blijft leven (kept_alive=true). Sandbox_id voor preview-host:" -ForegroundColor Yellow
    Write-Host "  $sandboxId" -ForegroundColor Yellow
    Write-Host "Plak in preview-host (mode: remote) en klik 'Expose in iframe'." -ForegroundColor Yellow
    Write-Host "Vergeet niet later 'Destroy sandbox' of E2B doet het na 30min timeout." -ForegroundColor Gray
  }
} else {
  Write-Host "CAPTURE niet OK. Error: $($capture.error)" -ForegroundColor Red
  Write-Host "Zie logs hierboven voor de crashende stap." -ForegroundColor Yellow
}
