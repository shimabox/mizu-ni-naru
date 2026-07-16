#!/bin/bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE=${1:-"$PROJECT_ROOT/build/screensaver/macos/MizuNiNaru.saver"}
if [[ "$SOURCE" != /* ]]; then
  SOURCE="$PROJECT_ROOT/$SOURCE"
fi
DESTINATION_DIR="$HOME/Library/Screen Savers"
DESTINATION="$DESTINATION_DIR/MizuNiNaru.saver"

if pgrep -x "System Settings" >/dev/null 2>&1; then
  echo "システム設定を終了してから、もう一度実行してください。" >&2
  exit 1
fi

"$PROJECT_ROOT/scripts/verify-macos-screensaver.sh" "$SOURCE"
pkill -x legacyScreenSaver >/dev/null 2>&1 || true
mkdir -p "$DESTINATION_DIR"
rm -rf "$DESTINATION"
ditto "$SOURCE" "$DESTINATION"
codesign --verify --deep --strict --verbose=2 "$DESTINATION"

echo "インストールしました: $DESTINATION"
echo "システム設定 > 壁紙 > スクリーンセーバーでMizuNiNaruを選択してください。"
