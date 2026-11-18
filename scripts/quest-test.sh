#!/usr/bin/env bash
# One-step test loop for the Quest app: pull the latest APK, install it, launch it, and collect a short log.
# The result is printed and, on a Mac, copied to the clipboard: just paste it into the chat.
# Usage: scripts/quest-test.sh [seconds to wait before reading the log, default 15]
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only -q
adb devices | grep -w device >/dev/null || { echo "No headset found: plug it in and accept the debugging prompt."; exit 1; }

adb install -r tuner-quest.apk >/dev/null
adb logcat -c
adb shell am force-stop app.tuner.quest
# QUEST_URL=https://... loads another deployment of the web app (e.g. a branch preview) instead of the live site.
if [ -n "${QUEST_URL:-}" ]; then
  adb shell am start -n app.tuner.quest/.MainActivity --es url "$QUEST_URL" >/dev/null
else
  adb shell am start -n app.tuner.quest/.MainActivity >/dev/null
fi
echo "Launched. Use the app now; collecting the log in ${1:-15}s..."
sleep "${1:-15}"

out="$(mktemp)"
{
  echo "build: $(git log -1 --format='%h %s')"
  echo "--- app log ---"
  adb logcat -d -s TunerQuest:I AndroidRuntime:E 'DEBUG:*' | grep -v -- '--------- beginning' | cut -c1-220 | tail -60
} > "$out"
cat "$out"
if command -v pbcopy >/dev/null; then pbcopy < "$out"; echo; echo "(copied to the clipboard)"; fi
