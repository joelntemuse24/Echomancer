# Test script for Echomancer v2 parallel pipeline
# Run this after deploying both Modal and Vercel

$MODAL_URL = "https://ntemusejoel--echomancer-f5-tts-fastapi-app.modal.run"
$VERCEL_URL = "https://echomancer-v2.vercel.app"

Write-Host "=== Echomancer v2 Deployment Test ===" -ForegroundColor Cyan
Write-Host ""

# 1. Test Modal health
Write-Host "1. Testing Modal health..." -ForegroundColor Yellow
$health = Invoke-RestMethod -Uri "$MODAL_URL/health" -Method GET -ErrorAction SilentlyContinue
if ($health.status -eq "ok") {
    Write-Host "   ✅ Modal health OK" -ForegroundColor Green
} else {
    Write-Host "   ❌ Modal health failed" -ForegroundColor Red
}
Write-Host ""

# 2. Test Modal warmup
Write-Host "2. Testing Modal warmup (spins up 4 GPU containers)..." -ForegroundColor Yellow
$warmupBody = @{ containers = 4 } | ConvertTo-Json -Depth 1
$warmupStart = Get-Date
try {
    $warmup = Invoke-RestMethod -Uri "$MODAL_URL/warmup" -Method POST -Body $warmupBody -ContentType "application/json" -TimeoutSec 120
    $warmupElapsed = ((Get-Date) - $warmupStart).TotalSeconds
    Write-Host "   ✅ Warmup complete in $($warmupElapsed.ToString('F1'))s" -ForegroundColor Green
    Write-Host "   Containers ready: $($warmup.containers_ready)" -ForegroundColor Gray
} catch {
    Write-Host "   ❌ Warmup failed: $_" -ForegroundColor Red
}
Write-Host ""

# 3. Test Vercel health (frontend)
Write-Host "3. Testing Vercel frontend..." -ForegroundColor Yellow
try {
    $vercel = Invoke-RestMethod -Uri "$VERCEL_URL" -Method GET -TimeoutSec 10
    Write-Host "   ✅ Vercel frontend loads" -ForegroundColor Green
} catch {
    Write-Host "   ❌ Vercel frontend failed: $_" -ForegroundColor Red
}
Write-Host ""

# 4. Test server-side warmup route
Write-Host "4. Testing Vercel /api/modal/warmup..." -ForegroundColor Yellow
$warmupBody2 = @{ containers = 4 } | ConvertTo-Json -Depth 1
try {
    $serverWarmup = Invoke-RestMethod -Uri "$VERCEL_URL/api/modal/warmup" -Method POST -Body $warmupBody2 -ContentType "application/json" -TimeoutSec 10
    Write-Host "   ✅ Server warmup triggered: $($serverWarmup.status)" -ForegroundColor Green
    Write-Host "   Message: $($serverWarmup.message)" -ForegroundColor Gray
} catch {
    Write-Host "   ❌ Server warmup failed: $_" -ForegroundColor Red
}
Write-Host ""

Write-Host "=== Test Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next: Upload a PDF on the site and watch Modal logs for:" -ForegroundColor Cyan
Write-Host "  - [API] Warming up 4 GPU containers..." -ForegroundColor Gray
Write-Host "  - [Job xxx] Farming 4 chunks to 4 workers via .map()" -ForegroundColor Gray
Write-Host "  - [Worker xxx] Chunk N done: X sections, Ys audio, Zs wall" -ForegroundColor Gray
Write-Host ""
Write-Host "View Modal logs: https://modal.com/apps/ntemusejoel/main/deployed/echomancer-f5-tts" -ForegroundColor Cyan
