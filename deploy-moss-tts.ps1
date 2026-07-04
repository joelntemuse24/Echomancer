# MOSS-TTS Deployment Script for Echomancer
# Deploys OpenMOSS MOSS-TTS-v1.5 flagship (MossTTSDelay-8B) to Modal.com
# Usage: .\deploy-moss-tts.ps1

param(
    [string]$ModalToken = "",
    [switch]$SkipAuth = $false
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  MOSS-TTS Deployment for Echomancer" -ForegroundColor Cyan
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
    Write-Host "Deploying MOSS-TTS server (initial build may take 15-25 min)..." -ForegroundColor Yellow
    Write-Host ""

    modal deploy moss_tts_server.py

    if ($LASTEXITCODE -ne 0) {
        throw "MOSS-TTS deployment failed"
    }

    Write-Host ""
    Write-Host "MOSS-TTS deployed successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Set these Vercel env vars:" -ForegroundColor Cyan
    Write-Host "  TTS_PIPELINE_MODE=moss" -ForegroundColor White
    Write-Host "  MODAL_MOSS_TTS_URL=https://<user>--echomancer-moss-tts-fastapi-app.modal.run/generate_batch" -ForegroundColor White
    Write-Host "  MODAL_TTS_URL=<same URL>  # for voice preview" -ForegroundColor White
    Write-Host ""
    Write-Host "Rollback: TTS_PIPELINE_MODE=f5 + point MODAL_TTS_URL at F5 app" -ForegroundColor Yellow
} finally {
    Pop-Location
}