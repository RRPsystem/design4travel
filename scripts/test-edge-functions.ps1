# scripts/test-edge-functions.ps1
#
# Test de sandbox-build-trigger en (optioneel) sandbox-callback Edge Functions.
#
# Gebruik voor iteratie 2b (echte build+screenshot):
#   .\scripts\test-edge-functions.ps1 -AnonKey "sb_publishable_..." -ArchivePath "spike-sandbox-target-<stamp>.tar.gz"
#
# Zonder -ArchivePath doet de trigger een 400 (archive_path_required). Die kan je
# gebruiken om alleen deploy-basis te bevestigen zonder een echte sandbox te starten.

param(
  # Bearer-token: user-JWT of service-role-key (dev-bypass). Anon key niet meer.
  [Parameter(Mandatory=$true)]
  [string]$BearerToken,

  [string]$ProjectRef = "ltzzxjrnhfcilfplpoep",

  [string]$ArchivePath = ""
)

$baseUrl = "https://$ProjectRef.supabase.co/functions/v1"
$headers = @{
  "Authorization" = "Bearer $BearerToken"
  "Content-Type"  = "application/json"
}

function Test-EdgeFunction {
  param([string]$Name, [string]$Body)

  Write-Host ""
  Write-Host "=== $Name ===" -ForegroundColor Cyan
  $url = "$baseUrl/$Name"
  Write-Host "POST $url"
  Write-Host "Body: $Body"
  try {
    $resp = Invoke-RestMethod -Method POST -Uri $url -Headers $headers -Body $Body
    $resp | ConvertTo-Json -Depth 20 | Write-Host
    return $resp
  } catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body = $reader.ReadToEnd()
        Write-Host "Response body: $body" -ForegroundColor Red
      } catch {}
    }
    return $null
  }
}

# ---- sandbox-build-trigger ----
$triggerBody = if ($ArchivePath) {
  ConvertTo-Json @{ archive_path = $ArchivePath } -Compress
} else {
  '{"test":"reachability-only"}'
}
$trigger = Test-EdgeFunction -Name "sandbox-build-trigger" -Body $triggerBody

# ---- sandbox-callback (stub, nog niet in gebruik) ----
$callback = Test-EdgeFunction -Name "sandbox-callback" -Body '{"test":"callback-reachability"}'

Write-Host ""
Write-Host "=== Samenvatting ===" -ForegroundColor Yellow

if ($null -eq $trigger) {
  Write-Host "FOUT - sandbox-build-trigger niet bereikbaar." -ForegroundColor Red
} elseif ($trigger.error) {
  Write-Host "sandbox-build-trigger antwoordde met error: $($trigger.error)" -ForegroundColor Yellow
  if ($trigger.duration_total_ms) {
    Write-Host "  Duurde: $($trigger.duration_total_ms)ms" -ForegroundColor Gray
  }
} elseif ($trigger.ok -and $trigger.screenshots) {
  Write-Host "OK - build+screenshot volledig geslaagd." -ForegroundColor Green
  Write-Host ""
  Write-Host "Desktop screenshot:" -ForegroundColor Green
  Write-Host "  $($trigger.screenshots.desktop_signed_url)"
  Write-Host "Mobile screenshot:" -ForegroundColor Green
  Write-Host "  $($trigger.screenshots.mobile_signed_url)"
  Write-Host ""
  Write-Host "Totaal: $($trigger.duration_total_ms)ms   sandbox: $($trigger.sandbox_id)" -ForegroundColor Gray
} elseif ($trigger.ok) {
  Write-Host "OK - sandbox-build-trigger bereikbaar (geen archive geleverd, dus geen build gedaan)." -ForegroundColor Green
  if ($trigger.probes) {
    Write-Host "  Probes: node=$($trigger.probes[0].stdout), npm=$($trigger.probes[1].stdout)" -ForegroundColor Gray
  }
} else {
  Write-Host "sandbox-build-trigger bereikbaar maar respons niet OK. Zie JSON hierboven." -ForegroundColor Yellow
}

if ($callback -and $callback.ok) {
  Write-Host "OK - sandbox-callback bereikbaar." -ForegroundColor Green
} else {
  Write-Host "FOUT - sandbox-callback niet bereikbaar of niet ok." -ForegroundColor Red
}
