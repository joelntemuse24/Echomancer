# F5-TTS Deployment Script for Echomancer
# Deploys F5-TTS and Audio Cleaner to Modal.com
# Usage: .\deploy-f5-tts.ps1

param(
    [string]$ModalToken = "",
    [switch]$SkipAuth = $false
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  F5-TTS Deployment for Echomancer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if modal is installed
$modalInstalled = Get-Command modal -ErrorAction SilentlyContinue
if (-not $modalInstalled) {
    Write-Host "Modal not found. Installing..." -ForegroundColor Yellow
    pip install modal
}

# Authenticate with Modal if needed
if (-not $SkipAuth) {
    Write-Host "Checking Modal authentication..." -ForegroundColor Yellow
    $authCheck = modal token show 2>&1
    if ($LASTEXITCODE -ne 0 -or -not $authCheck) {
        Write-Host "Please authenticate with Modal using your ntemusejoel@gmail.com account..." -ForegroundColor Yellow
        if ($ModalToken) {
            $env:MODAL_TOKEN_ID = $ModalToken
            modal token set --token-id $ModalToken
        } else {
            modal token new
        }
    } else {
        Write-Host "Already authenticated with Modal" -ForegroundColor Green
    }
}

# Change to modal directory
Push-Location modal

try {
    # Deploy F5-TTS Server
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Deploying F5-TTS Server..." -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "This may take 10-15 minutes for initial build..." -ForegroundColor Yellow
    Write-Host ""
    
    modal deploy f5_tts_server.py
    
    if ($LASTEXITCODE -ne 0) {
        throw "F5-TTS deployment failed"
    }
    
    Write-Host "F5-TTS deployed successfully!" -ForegroundColor Green
    
    # Deploy Audio Cleaner
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Deploying Audio Cleaner..." -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
    
    modal deploy audio_cleaner.py
    
    if ($LASTEXITCODE -ne 0) {
        throw "Audio Cleaner deployment failed"
    }
    
    Write-Host "Audio Cleaner deployed successfully!" -ForegroundColor Green
    
    # Get deployment URLs
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Getting Deployment URLs..." -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
    
    $apps = modal app list 2>&1
    Write-Host $apps
    
    # Extract URLs (this is a simple pattern match)
    $f5ttsUrl = $apps | Select-String -Pattern "echomancer-f5-tts.*\.modal\.run" | ForEach-Object { $_.Matches.Value }
    $cleanerUrl = $apps | Select-String -Pattern "echomancer-audio-cleaner.*\.modal\.run" | ForEach-Object { $_.Matches.Value }
    
    if ($f5ttsUrl) {
        $f5ttsUrl = "https://$f5ttsUrl/generate_batch"
    }
    if ($cleanerUrl) {
        $cleanerUrl = "https://$cleanerUrl/clean"
    }
    
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Deployment Complete!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "F5-TTS URL: $f5ttsUrl" -ForegroundColor Cyan
    Write-Host "Audio Cleaner URL: $cleanerUrl" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Update your .env.local with:" -ForegroundColor Yellow
    Write-Host "MODAL_TTS_URL=$f5ttsUrl" -ForegroundColor White
    Write-Host "MODAL_AUDIO_CLEANER_URL=$cleanerUrl" -ForegroundColor White
    Write-Host ""
    
} finally {
    Pop-Location
}

Write-Host "Done!" -ForegroundColor Green
