#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MANIFEST="android/app/src/main/AndroidManifest.xml"
BACKUP_RULES="android/app/src/main/res/xml/backup_rules.xml"
EXTRACTION_RULES="android/app/src/main/res/xml/data_extraction_rules.xml"
FILE_PATHS="android/app/src/main/res/xml/file_paths.xml"
SECRET_STORE="android/app/src/main/kotlin/com/voice2text/app/privacy/MeetingApiSecretStore.kt"
DEEPSEEK_PROVIDER="lib/features/meeting_intelligence/service/deepseek_meeting_intelligence_provider.dart"
DESKTOP_SECRET_STORE="apps/desktop/lib/features/secrets/desktop_secret_store.dart"
DESKTOP_DEEPSEEK_PROVIDER="apps/desktop/lib/features/meeting_intelligence/deepseek_desktop_provider.dart"
DESKTOP_NATIVE_WORKER="apps/desktop/lib/features/processing/native_sherpa_worker_engine.dart"
DESKTOP_DISK_ENCRYPTION="apps/desktop/lib/features/security/desktop_disk_encryption.dart"
DESKTOP_APP="apps/desktop/lib/app/desktop_app.dart"
COMPANION_ANDROID_STORE="android/app/src/main/kotlin/com/voice2text/app/companion/CompanionCredentialStore.kt"
COMPANION_ANDROID_PLATFORM="android/app/src/main/kotlin/com/voice2text/app/companion/CompanionPlatformPlugin.kt"
COMPANION_DESKTOP_STORE="apps/desktop/lib/features/companion/desktop_companion_credential_store.dart"
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
require_literal "$BACKUP_RULES" '<exclude domain="file" path="meetings" />'
require_literal "$BACKUP_RULES" '<exclude domain="file" path="logs" />'
require_literal "$BACKUP_RULES" '<exclude domain="file" path="diagnostics" />'
require_literal "$EXTRACTION_RULES" '<exclude domain="database" path="." />'
require_literal "$EXTRACTION_RULES" '<exclude domain="sharedpref" path="." />'
require_literal "$EXTRACTION_RULES" '<exclude domain="device_sharedpref" path="." />'
require_literal "$EXTRACTION_RULES" '<exclude domain="file" path="meetings" />'
require_literal "$EXTRACTION_RULES" '<exclude domain="file" path="logs" />'
require_literal "$EXTRACTION_RULES" '<exclude domain="file" path="diagnostics" />'
require_literal "$EXTRACTION_RULES" '<cloud-backup>'
require_literal "$EXTRACTION_RULES" '<device-transfer>'
require_literal "$SECRET_STORE" '"AndroidKeyStore"'
require_literal "$SECRET_STORE" '"AES/GCM/NoPadding"'
require_literal "$SECRET_STORE" 'Context.MODE_PRIVATE'
require_literal "$DEEPSEEK_PROVIDER" 'https://api.deepseek.com/chat/completions'
require_literal "$DESKTOP_SECRET_STORE" 'KeychainAccessibility.unlocked_this_device'
require_literal "$DESKTOP_SECRET_STORE" 'synchronizable: false'
require_literal "$DESKTOP_SECRET_STORE" 'usesDataProtectionKeychain: true'
require_literal "$DESKTOP_DEEPSEEK_PROVIDER" 'https://api.deepseek.com/chat/completions'
require_literal "$DESKTOP_NATIVE_WORKER" "environment: const <String, String>{'LANG': 'C.UTF-8'}"
require_literal "$DESKTOP_NATIVE_WORKER" 'includeParentEnvironment: false'
require_literal "$DESKTOP_DISK_ENCRYPTION" "/usr/bin/fdesetup"
require_literal "$DESKTOP_APP" "FileVault 磁盘加密未启用"
require_literal "$DESKTOP_APP" "会议数据库和音频没有应用层整库加密"
require_literal "$COMPANION_ANDROID_STORE" '"AndroidKeyStore"'
require_literal "$COMPANION_ANDROID_STORE" '"AES/GCM/NoPadding"'
require_literal "$COMPANION_ANDROID_STORE" 'Context.MODE_PRIVATE'
require_literal "$COMPANION_ANDROID_PLATFORM" '"_voice2text-media._tcp."'
require_literal "$COMPANION_ANDROID_PLATFORM" '"LOCAL_NETWORK_PERMISSION_DENIED"'
require_literal "$COMPANION_DESKTOP_STORE" 'KeychainAccessibility.unlocked_this_device'
require_literal "$COMPANION_DESKTOP_STORE" 'synchronizable: false'
require_literal "$COMPANION_DESKTOP_STORE" 'usesDataProtectionKeychain: true'
require_literal "$COMPANION_CRYPTO" 'Hkdf(hmac: Hmac.sha256(), outputLength: 64)'
require_literal "$COMPANION_CRYPTO" 'AesGcm.with256bits()'
require_literal "$COMPANION_CRYPTO" "'REPLAY_REJECTED'"

require_literal "$FILE_PATHS" 'path="meetings/exports/"'
require_literal "$FILE_PATHS" 'path="voice2text/sharing/ephemeral/"'
if rg -q '<root-path|<external-path' "$FILE_PATHS" ||
  rg -Fq 'path="."' "$FILE_PATHS" ||
  rg -Fq 'path="/"' "$FILE_PATHS"; then
  fail "FileProvider exposes a broad filesystem path"
fi

if rg -n \
  'https?://|Authorization|Bearer |api[_-]?key|client[_-]?secret' \
  lib/features/meeting_intelligence \
  -g '!deepseek_meeting_intelligence_provider.dart' \
  -g '!meeting_intelligence_http_client.dart' >/dev/null; then
  fail "meeting intelligence code outside the isolated transport contains an endpoint or credential shape"
fi

if rg -q 'sk-[A-Za-z0-9]{20,}' \
  lib apps/desktop/lib android/app/src/main/kotlin benchmark docs/product; then
  fail "source, product evidence, or benchmark output contains a credential-shaped literal"
fi

if rg -n -i \
  '(api[_-]?key|authorization|bearer|secret)' \
  apps/desktop/lib/features/processing \
  apps/desktop/lib/features/meeting_intelligence/desktop_meeting_ai_repository.dart \
  apps/desktop/lib/features/meetings/data >/dev/null; then
  fail "desktop worker or SQLite persistence boundary contains a credential shape"
fi

if rg -n \
  '(Authorization[[:space:]]*[:=][[:space:]]*Bearer|full[_-]?prompt[[:space:]]*[:=]|api[_-]?key[[:space:]]*[:=])' \
  lib/features/diagnostics android/app/src/main/kotlin/com/voice2text/app/diagnostics \
  2>/dev/null >/dev/null; then
  fail "diagnostics production code contains a secret/header/full-prompt shape"
fi

if rg -n '\bLog\.(v|d|i|w|e)\(' \
  android/app/src/main/kotlin \
  -g '!PrivacySafeLog.kt' >/dev/null; then
  fail "native production code bypasses PrivacySafeLog"
fi

if rg -n '\b(debugPrint|print)\(' \
  lib apps/desktop/lib \
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
