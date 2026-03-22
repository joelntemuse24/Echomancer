# Deploy Zonos TTS Server to Modal
# Run this in PowerShell

$ErrorActionPreference = "Stop"

Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "        Deploying Zonos TTS Server to Modal                " -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

# Check if modal is installed
try {
    $modalVersion = modal --version 2>$null
    Write-Host "✓ Modal CLI found: $modalVersion" -ForegroundColor Green
} catch {
    Write-Host "✗ Error: Modal CLI not found" -ForegroundColor Red
    Write-Host "Install with: pip install modal"
    exit 1
}

# Check if user is logged in
try {
    $tokenInfo = modal token show 2>&1
    if ($tokenInfo -match "not authenticated") {
        throw "Not authenticated"
    }
    Write-Host "✓ Logged in to Modal" -ForegroundColor Green
} catch {
    Write-Host "✗ Error: Not logged in to Modal" -ForegroundColor Red
    Write-Host "Run: modal token new"
    exit 1
}

Write-Host ""
Write-Host "Step 1: Deploying Zonos server..." -ForegroundColor Yellow
Write-Host "This may take 5-10 minutes for the first build..." -ForegroundColor Yellow
Write-Host ""

# Deploy the Zonos server
Set-Location modal
try {
    modal deploy zonos_server.py
    Write-Host ""
    Write-Host "✓ Zonos server deployed successfully!" -ForegroundColor Green
} catch {
    Write-Host "✗ Deployment failed" -ForegroundColor Red
    Write-Host $_.Exception.Message
    Set-Location ..
    exit 1
}
Set-Location ..

Write-Host ""
Write-Host "Step 2: Getting deployment URL..." -ForegroundColor Yellow

# Get deployment URL
$apps = modal app list 2>$null | Select-String "zonos-tts"
if ($apps) {
    # Parse the URL from modal output
    $DEPLOYMENT_URL = ($apps -split '\s+')[2]
    Write-Host "✓ Found deployment: $DEPLOYMENT_URL" -ForegroundColor Green
} else {
    Write-Host "⚠ Couldn't auto-detect deployment URL" -ForegroundColor Yellow
    Write-Host "Please find your URL in the Modal dashboard:" -ForegroundColor Yellow
    Write-Host "  https://modal.com/apps" -ForegroundColor Yellow
    Write-Host ""
    $DEPLOYMENT_URL = Read-Host "Enter your Zonos deployment URL (e.g., https://yourname--zonos-tts-zonoserver.modal.run)"
}

Write-Host ""
Write-Host "Step 3: Updating environment configuration..." -ForegroundColor Yellow

$envFile = ".env.local"
if (Test-Path $envFile) {
    # Backup
    $backupName = ".env.local.backup.$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    Copy-Item $envFile $backupName
    Write-Host "✓ Backed up to $backupName" -ForegroundColor Green
    
    # Read content
    $content = Get-Content $envFile -Raw
    
    # Update or add MODAL_TTS_URL
    if ($content -match "^MODAL_TTS_URL=") {
        # Update existing
        $content = $content -replace "^MODAL_TTS_URL=.*", "MODAL_TTS_URL=$DEPLOYMENT_URL"
    } else {
        # Add new
        $content += "`n`n# Zonos TTS Server`nMODAL_TTS_URL=$DEPLOYMENT_URL"
    }
    
    # Write back
    Set-Content $envFile $content -NoNewline
    Write-Host "✓ Updated $envFile" -ForegroundColor Green
} else {
    Write-Host "⚠ Warning: .env.local not found" -ForegroundColor Yellow
    Write-Host "Create it with:"
    Write-Host "  MODAL_TTS_URL=$DEPLOYMENT_URL"
}

Write-Host ""
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "🎉 Zonos deployment complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Summary:" -ForegroundColor White
Write-Host "  • Model: Zonos v0.1 Transformer"
Write-Host "  • GPU: L4 (cheaper than A10G)"
Write-Host "  • Max chunk size: 2000 characters"
Write-Host "  • Max voice sample: 30 seconds"
Write-Host "  • Expected cost: ~`$0.03 per book"
Write-Host ""
Write-Host "Updated files:" -ForegroundColor White
Write-Host "  • src/lib/generate-audiobook.ts (Zonos-compatible)"
Write-Host "  • src/lib/validation.ts (30s voice samples)"
Write-Host "  • .env.local (deployment URL)"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Restart Next.js: npm run dev"
Write-Host "  2. Test with a short PDF"
Write-Host "  3. Monitor costs in Modal dashboard"
Write-Host ""
Write-Host "════════════════════════════════════════════════════════════" -ForegroundColor Cyan
