# MOSI API TTS Deployment Script for Echomancer
# Deploys the MOSI Studio API-backed TTS server (same MOSS-TTS model, no self-hosted GPUs)
# Usage: .\deploy-mosi-api-tts.ps1

param(
    [string]$ModalToken = "",
    [switch]$SkipAuth = $false
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  MOSI API TTS Deployment for Echomancer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$modalInstalled = Get-Command modal -ErrorAction SilentlyContinue
if (-not $modalInstalled) {
    Write-Host "Modal not found. Installing..." -ForegroundColor Yellow
    pip install modal
}

if (-not $SkipAuth) {
    Write-Host "Checking Modal authentication..." -ForegroundColor Yellow
    $authCheck = modal token show 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $authCheck) {
        Write-Host "Please authenticate with Modal..." -ForegroundColor Yellow
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
    Write-Host "Deploying MOSI API TTS server (CPU-only, fast build)..." -ForegroundColor Yellow
    Write-Host ""

    modal deploy mosi_api_tts_server.py

    if ($LASTEXITCODE -ne 0) {
        throw "MOSI API TTS deployment failed"
    }

    Write-Host ""
    Write-Host "MOSI API TTS deployed successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Prerequisite: add your MOSI Studio API key to the Modal secret:" -ForegroundColor Cyan
    Write-Host "  1. Get a key at https://studio.mosi.cn (console -> API keys)" -ForegroundColor White
    Write-Host "  2. Add MOSI_TTS_API_KEY=sk-... to the 'echomancer-secrets' Modal secret" -ForegroundColor White
    Write-Host ""
    Write-Host "Set these Vercel env vars:" -ForegroundColor Cyan
    Write-Host "  TTS_PIPELINE_MODE=moss" -ForegroundColor White
    Write-Host "  MOSS_AB_VARIANT=api" -ForegroundColor White
    Write-Host "  MODAL_MOSS_API_TTS_URL=https://<user>--echomancer-mosi-api-tts-fastapi-app.modal.run/generate_batch" -ForegroundColor White
    Write-Host "  MODAL_TTS_URL=<same URL>  # voice preview + warmup" -ForegroundColor White
    Write-Host ""
    Write-Host "Rollback: MOSS_AB_VARIANT=delay (or local) with the self-hosted Modal apps" -ForegroundColor Yellow
} finally {
    Pop-Location
}
