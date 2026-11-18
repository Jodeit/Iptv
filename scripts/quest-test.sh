#!/usr/bin/env bash
# One-step test loop for the Quest app: pull the latest APK, install it, launch it, and print what matters.
# Usage: scripts/quest-test.sh [seconds to wait before reading the log, default 15]
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
adb devices | grep -w device >/dev/null || { echo "No headset found: plug it in and accept the debugging prompt."; exit 1; }

adb install -r tuner-quest.apk
adb logcat -c
adb shell am force-stop app.tuner.quest
adb shell am start -n app.tuner.quest/.MainActivity >/dev/null
echo "Launched. Use the app now; reading the log in ${1:-15}s..."
sleep "${1:-15}"

echo; echo "===== logcat (app, crashes) ====="
adb logcat -d | grep -E "TunerQuest|AndroidRuntime|FATAL|app\.tuner\.quest" | tail -80 || true
echo; echo "===== tuner-quest-log.txt (written by the app) ====="
adb shell cat /sdcard/Download/tuner-quest-log.txt 2>/dev/null | tail -80 || echo "(no log file yet)"
