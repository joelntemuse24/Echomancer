# MOSS-TTS via SGLang-Omni on Modal (production default)
# Usage: .\deploy-sglang.ps1

param(
    [string]$ModalToken = "",
    [switch]$SkipAuth = $false
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  SGLang MOSS-TTS Deployment" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Get-Command modal -ErrorAction SilentlyContinue)) {
    Write-Host "Modal not found. Installing..." -ForegroundColor Yellow
    pip install modal
}

if (-not $SkipAuth) {
    Write-Host "Checking Modal authentication..." -ForegroundColor Yellow
    $authCheck = modal token show 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $authCheck) {
        if ($ModalToken) {
            modal token set --token-id $ModalToken
        } else {
            modal token new
        }
    } else {
        Write-Host "Already authenticated with Modal" -ForegroundColor Green
    }
}

Push-Location modal
try {
    Write-Host ""
    Write-Host "Deploying SGLang MOSS-TTS (A100-80GB, first build may take 20-40 min)..." -ForegroundColor Yellow
    modal deploy sglang_tts_server.py
    if ($LASTEXITCODE -ne 0) { throw "SGLang deployment failed" }

    Write-Host ""
    Write-Host "Deployed successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Set these Vercel env vars:" -ForegroundColor Cyan
    Write-Host "  MOSS_AB_VARIANT=sglang" -ForegroundColor White
    Write-Host "  MODAL_MOSS_SGLANG_TTS_URL=https://<user>--echomancer-sglang-tts-fastapi-app.modal.run/generate_batch" -ForegroundColor White
    Write-Host "  MODAL_TTS_URL=<same URL>  # voice preview + warmup" -ForegroundColor White
    Write-Host ""
    Write-Host "Rollback: MOSS_AB_VARIANT=delay" -ForegroundColor Yellow
} finally {
    Pop-Location
}