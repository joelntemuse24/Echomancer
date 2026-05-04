#!/bin/bash
# F5-TTS Deployment Script for Echomancer
# Deploys F5-TTS and Audio Cleaner to Modal.com
# Usage: ./deploy-f5-tts.sh

set -e

echo "========================================"
echo "  F5-TTS Deployment for Echomancer"
echo "========================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if modal is installed
if ! command -v modal &> /dev/null; then
    echo -e "${YELLOW}Modal not found. Installing...${NC}"
    pip install modal
fi

# Authenticate with Modal if needed
echo -e "${YELLOW}Checking Modal authentication...${NC}"
if ! modal token show &> /dev/null; then
    echo -e "${YELLOW}Please authenticate with Modal using your ntemusejoel@gmail.com account...${NC}"
    modal token new
else
    echo -e "${GREEN}Already authenticated with Modal${NC}"
fi

# Change to modal directory
cd modal

# Deploy F5-TTS Server
echo ""
echo "========================================"
echo -e "${CYAN}  Deploying F5-TTS Server...${NC}"
echo "========================================"
echo -e "${YELLOW}This may take 10-15 minutes for initial build...${NC}"
echo ""

modal deploy f5_tts_server.py

echo -e "${GREEN}F5-TTS deployed successfully!${NC}"

# Deploy Audio Cleaner
echo ""
echo "========================================"
echo -e "${CYAN}  Deploying Audio Cleaner...${NC}"
echo "========================================"
echo ""

modal deploy audio_cleaner.py

echo -e "${GREEN}Audio Cleaner deployed successfully!${NC}"

# Get deployment URLs
echo ""
echo "========================================"
echo -e "${CYAN}  Getting Deployment URLs...${NC}"
echo "========================================"
echo ""

modal app list

echo ""
echo "========================================"
echo -e "${GREEN}  Deployment Complete!${NC}"
echo "========================================"
echo ""
echo -e "${YELLOW}Update your .env.local with the URLs above${NC}"
echo ""

cd ..

echo -e "${GREEN}Done!${NC}"
