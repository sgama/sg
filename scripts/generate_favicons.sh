#!/bin/bash
set -euo pipefail

SOURCE_FILE="${FAVICON_SOURCE:-assets/samson.webp}"
OUTPUT_DIR="${FAVICON_OUTPUT_DIR:-static}"

if command -v magick >/dev/null 2>&1; then
    converter=(magick)
elif command -v convert >/dev/null 2>&1; then
    converter=(convert)
else
    echo "Missing ImageMagick. Install it before running make favicons." >&2
    exit 1
fi
if [ ! -f "$SOURCE_FILE" ]; then
    echo "Missing favicon source: $SOURCE_FILE" >&2
    exit 1
fi
mkdir -p "$OUTPUT_DIR"
for entry in \
    "192:android-chrome-192x192.png" \
    "512:android-chrome-512x512.png" \
    "180:apple-touch-icon.png" \
    "16:favicon-16x16.png" \
    "32:favicon-32x32.png"; do
    size="${entry%%:*}"
    name="${entry#*:}"
    "${converter[@]}" "$SOURCE_FILE" -auto-orient -thumbnail "${size}x${size}" \
        -background none -gravity center -extent "${size}x${size}" "$OUTPUT_DIR/$name"
    test -s "$OUTPUT_DIR/$name" || { echo "Empty favicon output: $name" >&2; exit 1; }
done
"${converter[@]}" "$SOURCE_FILE" -auto-orient -thumbnail 256x256 \
    -background none -gravity center -extent 256x256 \
    -define icon:auto-resize=64,48,32,16 "$OUTPUT_DIR/favicon.ico"
test -s "$OUTPUT_DIR/favicon.ico" || { echo "Empty favicon output: favicon.ico" >&2; exit 1; }
echo "Generated favicon assets in $OUTPUT_DIR from $SOURCE_FILE."
