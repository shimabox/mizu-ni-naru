#!/bin/bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUNDLE=${1:-"$PROJECT_ROOT/build/screensaver/macos/MizuNiNaru.saver"}
if [[ "$BUNDLE" != /* ]]; then
  BUNDLE="$PROJECT_ROOT/$BUNDLE"
fi
EXECUTABLE="$BUNDLE/Contents/MacOS/MizuNiNaru"
PLIST="$BUNDLE/Contents/Info.plist"
VIDEOS="$BUNDLE/Contents/Resources/Videos"
MANIFEST="$VIDEOS/manifest.json"

if [[ ! -d "$BUNDLE" ]]; then
  echo "バンドルがありません: $BUNDLE" >&2
  exit 1
fi

plutil -lint "$PLIST" >/dev/null
[[ $(plutil -extract CFBundlePackageType raw "$PLIST") == "BNDL" ]]
[[ $(plutil -extract NSPrincipalClass raw "$PLIST") == \
  "MizuNiNaruScreenSaverView" ]]
[[ $(plutil -extract CFBundleExecutable raw "$PLIST") == "MizuNiNaru" ]]

file "$EXECUTABLE" | grep -q "Mach-O universal binary"
ARCHS=" $(lipo -archs "$EXECUTABLE") "
[[ "$ARCHS" == *" arm64 "* ]]
[[ "$ARCHS" == *" x86_64 "* ]]
otool -L "$EXECUTABLE" | grep -q "AVFoundation.framework"
codesign --verify --deep --strict --verbose=2 "$BUNDLE"

[[ -s "$MANIFEST" ]]
[[ $(plutil -extract options.outputDurationSeconds raw "$MANIFEST") == "60" ]]
[[ $(plutil -extract options.width raw "$MANIFEST") == "1280" ]]
[[ $(plutil -extract options.height raw "$MANIFEST") == "720" ]]
[[ $(plutil -extract options.fps raw "$MANIFEST") == "30" ]]
[[ $(plutil -extract options.codec raw "$MANIFEST") == "h264" ]]

for name in morning day evening night; do
  VIDEO="$VIDEOS/$name.mp4"
  [[ -s "$VIDEO" ]]
  if command -v ffprobe >/dev/null 2>&1; then
    [[ $(ffprobe -v error -select_streams v:0 \
      -show_entries stream=codec_name -of default=nw=1:nk=1 "$VIDEO") == \
      "h264" ]]
    [[ $(ffprobe -v error -select_streams v:0 \
      -show_entries stream=pix_fmt -of default=nw=1:nk=1 "$VIDEO") == \
      "yuv420p" ]]
    [[ $(ffprobe -v error -select_streams v:0 \
      -show_entries stream=width -of default=nw=1:nk=1 "$VIDEO") == \
      "1280" ]]
    [[ $(ffprobe -v error -select_streams v:0 \
      -show_entries stream=height -of default=nw=1:nk=1 "$VIDEO") == \
      "720" ]]
    DURATION=$(ffprobe -v error -show_entries format=duration \
      -of default=nw=1:nk=1 "$VIDEO")
    awk -v duration="$DURATION" \
      'BEGIN { exit !(duration >= 59.9 && duration <= 60.1) }'
  fi
done

VERIFY_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mizu-screensaver-verify.XXXXXX")
trap 'rm -rf "$VERIFY_DIR"' EXIT
HOST_ARCH=$(uname -m)
SOURCE_DIR="$PROJECT_ROOT/screensaver/macos/Sources"
TEST_DIR="$PROJECT_ROOT/screensaver/macos/Tests"

clang -fobjc-arc -Wall -Wextra -Werror \
  -arch "$HOST_ARCH" -mmacosx-version-min=14.0 \
  -I"$SOURCE_DIR" \
  "$SOURCE_DIR/MizuTimePeriod.m" "$TEST_DIR/MizuTimePeriodTests.m" \
  -o "$VERIFY_DIR/MizuTimePeriodTests" \
  -framework Foundation
"$VERIFY_DIR/MizuTimePeriodTests"

clang -fobjc-arc -Wall -Wextra -Werror \
  -arch "$HOST_ARCH" -mmacosx-version-min=14.0 \
  "$TEST_DIR/VerifyBundle.m" \
  -o "$VERIFY_DIR/VerifyBundle" \
  -framework Cocoa -framework ScreenSaver
"$VERIFY_DIR/VerifyBundle" "$BUNDLE"

echo "検証に成功しました: $BUNDLE"
