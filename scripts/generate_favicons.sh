#!/bin/bash

# Favicon Generation Script for samsongama.com
# This script generates all required favicon and icon files from SVG source

set -e

echo "🎨 Generating favicons and icons for samsongama.com..."

# Check if ImageMagick is installed
if ! command -v convert &> /dev/null; then
    echo "❌ ImageMagick is not installed. Installing..."
    # For Ubuntu/Debian
    if command -v apt &> /dev/null; then
        sudo apt update && sudo apt install -y imagemagick
    # For macOS
    elif command -v brew &> /dev/null; then
        brew install imagemagick
    # For CentOS/RHEL
    elif command -v yum &> /dev/null; then
        sudo yum install -y ImageMagick
    else
        echo "❌ Please install ImageMagick manually and run this script again"
        exit 1
    fi
fi

# Source files (try SVG first, fallback to JPG)
SOURCE_SVG="assets/primary_logo.svg"
SOURCE_JPG="assets/samson.jpg"
STATIC_DIR="static"

# Determine which source file to use
if [ -f "$SOURCE_SVG" ]; then
    SOURCE_FILE="$SOURCE_SVG"
    BACKGROUND_OPTION="-background none"
    echo "📁 Using SVG source: $SOURCE_SVG"
elif [ -f "$SOURCE_JPG" ]; then
    SOURCE_FILE="$SOURCE_JPG"
    BACKGROUND_OPTION=""
    echo "📁 Using JPG source: $SOURCE_JPG"
else
    echo "❌ No source file found. Checked:"
    echo "  - $SOURCE_SVG"
    echo "  - $SOURCE_JPG"
    exit 1
fi

# Create static directory if it doesn't exist
mkdir -p "$STATIC_DIR"

echo "📱 Generating Android Chrome icons..."
# Android Chrome icons
convert $BACKGROUND_OPTION -resize 192x192 "$SOURCE_FILE" "$STATIC_DIR/android-chrome-192x192.png"
convert $BACKGROUND_OPTION -resize 512x512 "$SOURCE_FILE" "$STATIC_DIR/android-chrome-512x512.png"

echo "🍎 Generating Apple Touch icon..."
# Apple Touch icon (180x180 for modern iOS)
convert $BACKGROUND_OPTION -resize 180x180 "$SOURCE_FILE" "$STATIC_DIR/apple-touch-icon.png"

echo "🌐 Generating standard favicons..."
# Standard favicons
convert $BACKGROUND_OPTION -resize 16x16 "$SOURCE_FILE" "$STATIC_DIR/favicon-16x16.png"
convert $BACKGROUND_OPTION -resize 32x32 "$SOURCE_FILE" "$STATIC_DIR/favicon-32x32.png"

echo "🔗 Generating ICO favicon..."
# Create multi-resolution ICO file (simplified approach)
if [ "$SOURCE_FILE" = "$SOURCE_SVG" ]; then
    # SVG source - use advanced ICO generation
    convert $BACKGROUND_OPTION "$SOURCE_FILE" \
        \( -clone 0 -resize 16x16 \) \
        \( -clone 0 -resize 32x32 \) \
        \( -clone 0 -resize 48x48 \) \
        \( -clone 0 -resize 64x64 \) \
        -delete 0 "$STATIC_DIR/favicon.ico"
else
    # JPG source - use simple conversion
    convert -resize 32x32 "$SOURCE_FILE" "$STATIC_DIR/favicon.ico"
fi

echo "✅ All favicon files generated successfully!"

# Verify generated files
echo "📋 Generated files:"
GENERATED_FILES=(
    "$STATIC_DIR/android-chrome-192x192.png"
    "$STATIC_DIR/android-chrome-512x512.png"
    "$STATIC_DIR/apple-touch-icon.png"
    "$STATIC_DIR/favicon-16x16.png"
    "$STATIC_DIR/favicon-32x32.png"
    "$STATIC_DIR/favicon.ico"
)

ALL_GENERATED=true
for file in "${GENERATED_FILES[@]}"; do
    if [ -f "$file" ]; then
        size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "unknown")
        echo "  ✅ $(basename "$file") (${size} bytes)"
    else
        echo "  ❌ $(basename "$file") - MISSING"
        ALL_GENERATED=false
    fi
done

if [ "$ALL_GENERATED" = true ]; then
    echo "🎉 Favicon generation complete! All files generated successfully."
    echo "� Web manifest already exists: static/site.webmanifest"
else
    echo "⚠️  Some files failed to generate. Check the errors above."
    exit 1
fi
