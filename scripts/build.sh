#!/bin/bash

# ========================================
#   coolAI Build Script (Linux/Mac)
# ========================================

set -e

echo "========================================"
echo "  coolAI Build Script"
echo "========================================"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js not found. Please install Node.js 20+ from https://nodejs.org"
    exit 1
fi

echo "[1/3] Installing dependencies..."
npm install

echo ""
echo "[2/3] Building TypeScript..."
npm run build

echo ""
echo "[3/3] Creating global command..."
npm link || echo "[WARN] Failed to create global command. Run 'sudo npm link' manually."

echo ""
echo "========================================"
echo "  Build Complete!"
echo "========================================"
echo ""
echo "Run 'coolAI' to start the application."
echo ""
