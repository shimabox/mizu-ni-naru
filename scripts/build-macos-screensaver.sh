#!/bin/bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUTPUT=${1:-"$PROJECT_ROOT/build/screensaver/macos/MizuNiNaru.saver"}
if [[ "$OUTPUT" != /* ]]; then
  OUTPUT="$PROJECT_ROOT/$OUTPUT"
fi

if [[ $(uname -s) != "Darwin" ]]; then
  echo "macOSで実行してください。" >&2
  exit 1
fi

SOURCE_DIR="$PROJECT_ROOT/screensaver/macos/Sources"
RESOURCE_DIR="$PROJECT_ROOT/screensaver/macos/Resources/Videos"
PLIST="$PROJECT_ROOT/screensaver/macos/Info.plist"
for name in morning day evening night; do
  if [[ ! -s "$RESOURCE_DIR/$name.mp4" ]]; then
    echo "動画がありません: $RESOURCE_DIR/$name.mp4" >&2
    exit 1
  fi
done
if [[ ! -s "$RESOURCE_DIR/manifest.json" ]]; then
  echo "動画manifestがありません: $RESOURCE_DIR/manifest.json" >&2
  exit 1
fi

STAGING=$(mktemp -d "${TMPDIR:-/tmp}/mizu-screensaver-build.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT
BUNDLE="$STAGING/MizuNiNaru.saver"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources/Videos"
cp "$PLIST" "$BUNDLE/Contents/Info.plist"
cp "$RESOURCE_DIR"/*.mp4 "$RESOURCE_DIR/manifest.json" \
  "$BUNDLE/Contents/Resources/Videos/"

clang \
  -fobjc-arc \
  -Wall \
  -Wextra \
  -Werror \
  -arch arm64 \
  -arch x86_64 \
  -mmacosx-version-min=14.0 \
  -I"$SOURCE_DIR" \
  -bundle \
  "$SOURCE_DIR/MizuNiNaruScreenSaverView.m" \
  "$SOURCE_DIR/MizuTimePeriod.m" \
  -o "$BUNDLE/Contents/MacOS/MizuNiNaru" \
  -framework Cocoa \
  -framework ScreenSaver \
  -framework AVFoundation \
  -framework QuartzCore \
  -framework CoreMedia

codesign --force --deep --sign - --timestamp=none "$BUNDLE"
"$PROJECT_ROOT/scripts/verify-macos-screensaver.sh" "$BUNDLE"

mkdir -p "$(dirname "$OUTPUT")"
rm -rf "$OUTPUT"
mv "$BUNDLE" "$OUTPUT"
echo "生成しました: $OUTPUT"
