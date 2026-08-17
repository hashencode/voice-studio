#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MOBILE_ROOT="apps/mobile-flutter"

MANIFEST="$MOBILE_ROOT/android/app/src/main/AndroidManifest.xml"
BACKUP_RULES="$MOBILE_ROOT/android/app/src/main/res/xml/backup_rules.xml"
EXTRACTION_RULES="$MOBILE_ROOT/android/app/src/main/res/xml/data_extraction_rules.xml"
FILE_PATHS="$MOBILE_ROOT/android/app/src/main/res/xml/file_paths.xml"
SECRET_STORE="$MOBILE_ROOT/android/app/src/main/kotlin/com/voice2text/app/privacy/AudioApiSecretStore.kt"
DEEPSEEK_PROVIDER="$MOBILE_ROOT/lib/features/audio_intelligence/service/deepseek_audio_intelligence_provider.dart"
COMPANION_ANDROID_STORE="$MOBILE_ROOT/android/app/src/main/kotlin/com/voice2text/app/companion/CompanionCredentialStore.kt"
COMPANION_ANDROID_PLATFORM="$MOBILE_ROOT/android/app/src/main/kotlin/com/voice2text/app/companion/CompanionPlatformPlugin.kt"
COMPANION_CRYPTO="packages/companion_protocol/lib/src/companion_crypto.dart"

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
require_literal "$MANIFEST" '<uses-permission android:name="android.permission.INTERNET" />'
require_literal "$BACKUP_RULES" '<exclude domain="database" path="." />'
require_literal "$BACKUP_RULES" '<exclude domain="sharedpref" path="." />'
require_literal "$BACKUP_RULES" '<exclude domain="device_sharedpref" path="." />'
require_literal "$BACKUP_RULES" '<exclude domain="file" path="audios" />'
require_literal "$BACKUP_RULES" '<exclude domain="file" path="logs" />'
require_literal "$BACKUP_RULES" '<exclude domain="file" path="diagnostics" />'
require_literal "$EXTRACTION_RULES" '<exclude domain="database" path="." />'
require_literal "$EXTRACTION_RULES" '<exclude domain="sharedpref" path="." />'
require_literal "$EXTRACTION_RULES" '<exclude domain="device_sharedpref" path="." />'
require_literal "$EXTRACTION_RULES" '<exclude domain="file" path="audios" />'
require_literal "$EXTRACTION_RULES" '<exclude domain="file" path="logs" />'
require_literal "$EXTRACTION_RULES" '<exclude domain="file" path="diagnostics" />'
require_literal "$EXTRACTION_RULES" '<cloud-backup>'
require_literal "$EXTRACTION_RULES" '<device-transfer>'
require_literal "$SECRET_STORE" '"AndroidKeyStore"'
require_literal "$SECRET_STORE" '"AES/GCM/NoPadding"'
require_literal "$SECRET_STORE" 'Context.MODE_PRIVATE'
require_literal "$DEEPSEEK_PROVIDER" 'https://api.deepseek.com/chat/completions'
require_literal "$COMPANION_ANDROID_STORE" '"AndroidKeyStore"'
require_literal "$COMPANION_ANDROID_STORE" '"AES/GCM/NoPadding"'
require_literal "$COMPANION_ANDROID_STORE" 'Context.MODE_PRIVATE'
require_literal "$COMPANION_ANDROID_PLATFORM" '"_voice2text-media._tcp."'
require_literal "$COMPANION_ANDROID_PLATFORM" '"LOCAL_NETWORK_PERMISSION_DENIED"'
require_literal "$COMPANION_CRYPTO" 'Hkdf(hmac: Hmac.sha256(), outputLength: 64)'
require_literal "$COMPANION_CRYPTO" 'AesGcm.with256bits()'
require_literal "$COMPANION_CRYPTO" "'REPLAY_REJECTED'"

require_literal "$FILE_PATHS" 'path="audios/exports/"'
require_literal "$FILE_PATHS" 'path="voice2text/sharing/ephemeral/"'
if rg -q '<root-path|<external-path' "$FILE_PATHS" ||
  rg -Fq 'path="."' "$FILE_PATHS" ||
  rg -Fq 'path="/"' "$FILE_PATHS"; then
  fail "FileProvider exposes a broad filesystem path"
fi

if rg -n \
  'https?://|Authorization|Bearer |api[_-]?key|client[_-]?secret' \
  "$MOBILE_ROOT/lib/features/audio_intelligence" \
  -g '!deepseek_audio_intelligence_provider.dart' \
  -g '!audio_intelligence_http_client.dart' >/dev/null; then
  fail "audio intelligence code outside the isolated transport contains an endpoint or credential shape"
fi

if rg -q 'sk-[A-Za-z0-9]{20,}' \
  "$MOBILE_ROOT/lib" "$MOBILE_ROOT/android/app/src/main/kotlin" benchmark docs/product \
  apps/desktop-electron/src packages/desktop_macos_native/Sources; then
  fail "source, product evidence, or benchmark output contains a credential-shaped literal"
fi

if rg -n \
  '(Authorization[[:space:]]*[:=][[:space:]]*Bearer|full[_-]?prompt[[:space:]]*[:=]|api[_-]?key[[:space:]]*[:=])' \
  "$MOBILE_ROOT/lib/features/diagnostics" "$MOBILE_ROOT/android/app/src/main/kotlin/com/voice2text/app/diagnostics" \
  2>/dev/null >/dev/null; then
  fail "diagnostics production code contains a secret/header/full-prompt shape"
fi

if rg -n '\bLog\.(v|d|i|w|e)\(' \
  "$MOBILE_ROOT/android/app/src/main/kotlin" \
  -g '!PrivacySafeLog.kt' >/dev/null; then
  fail "native production code bypasses PrivacySafeLog"
fi

if rg -n '\b(debugPrint|print)\(' \
  "$MOBILE_ROOT/lib" \
  -g '!privacy_safe_log.dart' >/dev/null; then
  fail "Dart production code bypasses PrivacySafeLog"
fi

if rg -n \
  '\b(recordingPath|recording_path|resultText|transcriptText|audioTitle|filePath|displayName|uri|content|message)\b\s+to\b' \
  "$MOBILE_ROOT/android/app/src/main/kotlin/com/voice2text/app/MainActivity.kt" >/dev/null ||
  rg -n \
    "['\"](recordingPath|recording_path|resultText|transcriptText|audioTitle|filePath|displayName|uri|content|message)['\"]\\s*:" \
    "$MOBILE_ROOT/lib/app/app.dart" >/dev/null; then
  fail "structured production logs may expose audio content or identifiers"
fi

if rg -q 'android:usesCleartextTraffic="true"' "$MANIFEST"; then
  fail "cleartext traffic is explicitly enabled"
fi

echo "Privacy contract check passed."
