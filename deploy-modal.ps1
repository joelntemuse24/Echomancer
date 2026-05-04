# Deployment script for Modal apps
# Filters out problematic Unicode characters

$ErrorActionPreference = "Continue"

# Set encoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"

Write-Host "Deploying F5-TTS Server..." -ForegroundColor Cyan

# Deploy with filtered output
& modal deploy modal/f5_tts_server.py 2>&1 | ForEach-Object {
    # Remove non-ASCII characters
    $clean = $_ -replace '[^\x00-\x7F]', ''
    Write-Host $clean
}

Write-Host "`nDeploying Audio Cleaner..." -ForegroundColor Cyan

& modal deploy modal/audio_cleaner.py 2>&1 | ForEach-Object {
    $clean = $_ -replace '[^\x00-\x7F]', ''
    Write-Host $clean
}

Write-Host "`nDone!" -ForegroundColor Green
