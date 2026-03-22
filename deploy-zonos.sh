#!/bin/bash
# Deploy Zonos TTS Server to Modal
# This script deploys the Zonos TTS server and updates your environment

set -e

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║        Deploying Zonos TTS Server to Modal                ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if modal is installed
if ! command -v modal &> /dev/null; then
    echo -e "${RED}Error: Modal CLI not found${NC}"
    echo "Install with: pip install modal"
    exit 1
fi

# Check if user is logged in to Modal
if ! modal token show &> /dev/null; then
    echo -e "${RED}Error: Not logged in to Modal${NC}"
    echo "Run: modal token new"
    exit 1
fi

echo -e "${YELLOW}Step 1: Deploying Zonos server...${NC}"
echo "This may take 5-10 minutes for the first build..."
echo ""

# Deploy the Zonos server
cd modal
modal deploy zonos_server.py

echo ""
echo -e "${GREEN}✓ Zonos server deployed successfully!${NC}"
echo ""

# Get the deployment URL
echo -e "${YELLOW}Step 2: Getting deployment URL...${NC}"

# Try to get the URL from modal
DEPLOYMENT_URL=$(modal app list | grep zonos-tts | awk '{print $3}' | head -1)

if [ -z "$DEPLOYMENT_URL" ]; then
    echo ""
    echo -e "${YELLOW}Couldn't auto-detect deployment URL.${NC}"
    echo "Please find your URL in the Modal dashboard:"
    echo "  https://modal.com/apps"
    echo ""
    read -p "Enter your Zonos deployment URL (e.g., https://yourname--zonos-tts-zonoserver.modal.run): " DEPLOYMENT_URL
fi

echo ""
echo -e "${GREEN}✓ Deployment URL: $DEPLOYMENT_URL${NC}"
echo ""

# Update environment file
echo -e "${YELLOW}Step 3: Updating environment configuration...${NC}"

if [ -f ../.env.local ]; then
    # Backup existing env
    cp ../.env.local ../.env.local.backup.$(date +%Y%m%d_%H%M%S)
    
    # Update or add MODAL_TTS_URL
    if grep -q "^MODAL_TTS_URL=" ../.env.local; then
        # Update existing
        sed -i "s|^MODAL_TTS_URL=.*|MODAL_TTS_URL=$DEPLOYMENT_URL|" ../.env.local
    else
        # Add new
        echo "" >> ../.env.local
        echo "# Zonos TTS Server" >> ../.env.local
        echo "MODAL_TTS_URL=$DEPLOYMENT_URL" >> ../.env.local
    fi
    
    echo -e "${GREEN}✓ Updated .env.local${NC}"
else
    echo -e "${YELLOW}Warning: .env.local not found${NC}"
    echo "Create it with:"
    echo "  MODAL_TTS_URL=$DEPLOYMENT_URL"
fi

echo ""
echo -e "${YELLOW}Step 4: Testing deployment...${NC}"

# Health check
HEALTH_URL="${DEPLOYMENT_URL/\/generate/}/health"
if curl -s "$HEALTH_URL" | grep -q "ok"; then
    echo -e "${GREEN}✓ Health check passed${NC}"
else
    echo -e "${YELLOW}⚠ Health check failed or not available yet${NC}"
    echo "The server may still be starting up. Try again in a minute."
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo ""
echo -e "${GREEN}🎉 Zonos deployment complete!${NC}"
echo ""
echo "Summary:"
echo "  • Model: Zonos v0.1 Transformer"
echo "  • GPU: L4 (cheaper than A10G)"
echo "  • Max chunk size: 2000 characters"
echo "  • Max voice sample: 30 seconds"
echo "  • Expected cost: ~$0.03 per book"
echo ""
echo "Updated files:"
echo "  • src/lib/generate-audiobook.ts (Zonos-compatible)"
echo "  • src/lib/validation.ts (30s voice samples)"
echo "  • .env.local (deployment URL)"
echo ""
echo "Next steps:"
echo "  1. Test with a short PDF"
echo "  2. Monitor costs in Modal dashboard"
echo "  3. Compare quality with F5-TTS"
echo ""
echo "To switch back to F5-TTS:"
echo "  export MODAL_TTS_URL=your-f5-tts-url"
echo ""
echo "════════════════════════════════════════════════════════════"
