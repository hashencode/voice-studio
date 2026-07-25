#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MANIFEST="android/app/src/main/AndroidManifest.xml"
BACKUP_RULES="android/app/src/main/res/xml/backup_rules.xml"
EXTRACTION_RULES="android/app/src/main/res/xml/data_extraction_rules.xml"
FILE_PATHS="android/app/src/main/res/xml/file_paths.xml"

fail() {
  echo "Privacy contract failed: $1" >&2
  exit 1
}

require_literal() {
  local file="$1"
  local literal="$2"
  rg -Fq "$literal" "$file" ||
    fail "$file is missing required rule: $literal"
}

require_literal "$MANIFEST" 'android:fullBackupContent="@xml/backup_rules"'
require_literal "$MANIFEST" 'android:dataExtractionRules="@xml/data_extraction_rules"'
require_literal "$MANIFEST" 'android:allowBackup="false"'
require_literal "$BACKUP_RULES" '<exclude domain="database" path="." />'
require_literal "$BACKUP_RULES" '<exclude domain="file" path="meetings" />'
require_literal "$BACKUP_RULES" '<exclude domain="file" path="logs" />'
require_literal "$BACKUP_RULES" '<exclude domain="file" path="diagnostics" />'
require_literal "$EXTRACTION_RULES" '<exclude domain="database" path="." />'
require_literal "$EXTRACTION_RULES" '<exclude domain="file" path="meetings" />'
require_literal "$EXTRACTION_RULES" '<exclude domain="file" path="logs" />'
require_literal "$EXTRACTION_RULES" '<exclude domain="file" path="diagnostics" />'
require_literal "$EXTRACTION_RULES" '<cloud-backup>'
require_literal "$EXTRACTION_RULES" '<device-transfer>'

require_literal "$FILE_PATHS" 'path="meetings/exports/"'
require_literal "$FILE_PATHS" 'path="voice2text/sharing/ephemeral/"'
if rg -q '<root-path|<external-path' "$FILE_PATHS" ||
  rg -Fq 'path="."' "$FILE_PATHS" ||
  rg -Fq 'path="/"' "$FILE_PATHS"; then
  fail "FileProvider exposes a broad filesystem path"
fi

if rg -n \
  'https?://|Authorization|Bearer |api[_-]?key|client[_-]?secret' \
  lib/features/meeting_intelligence >/dev/null; then
  fail "meeting intelligence production code contains an endpoint or credential shape"
fi

if rg -n '\bLog\.(v|d|i|w|e)\(' \
  android/app/src/main/kotlin \
  -g '!PrivacySafeLog.kt' >/dev/null; then
  fail "native production code bypasses PrivacySafeLog"
fi

if rg -n '\b(debugPrint|print)\(' \
  lib \
  -g '!privacy_safe_log.dart' >/dev/null; then
  fail "Dart production code bypasses PrivacySafeLog"
fi

if rg -n \
  '\b(recordingPath|recording_path|resultText|transcriptText|meetingTitle|filePath|displayName|uri|content|message)\b\s+to\b' \
  android/app/src/main/kotlin/com/voice2text/app/MainActivity.kt >/dev/null ||
  rg -n \
    "['\"](recordingPath|recording_path|resultText|transcriptText|meetingTitle|filePath|displayName|uri|content|message)['\"]\\s*:" \
    lib/app/app.dart >/dev/null; then
  fail "structured production logs may expose meeting content or identifiers"
fi

if rg -q 'android:usesCleartextTraffic="true"' "$MANIFEST"; then
  fail "cleartext traffic is explicitly enabled"
fi

echo "Privacy contract check passed."
