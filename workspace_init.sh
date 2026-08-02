#!/bin/bash

# Workspace initialization script
# Runs automatically when a workspace is created
# $1 = original project directory

set -e

ORIGINAL_DIR="$1"

if [ -z "$ORIGINAL_DIR" ]; then
  echo "Error: Original project directory not provided"
  exit 1
fi

echo "Initializing workspace from: $ORIGINAL_DIR"

# Install npm modules preferring local cache
echo "Installing npm modules..."
if [ -d "$ORIGINAL_DIR/node_modules" ]; then
  echo "Found local node_modules cache, copying..."
  cp -r "$ORIGINAL_DIR/node_modules" . 2>/dev/null || true
fi

npm install --prefer-offline


echo "Workspace initialization complete!"
