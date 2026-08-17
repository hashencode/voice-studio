#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MOBILE_ROOT="$ROOT/apps/mobile-flutter"

python3 tool/build_cache_guard.py

failures=0
warns=0
TODOS=()

ok() { echo "[OK] $1"; }
warn() { echo "[WARN] $1"; warns=$((warns+1)); }
err() { echo "[ERR] $1"; failures=$((failures+1)); }
add_todo() { TODOS+=("$1"); }

PUBSPEC="$MOBILE_ROOT/pubspec.yaml"
MANIFEST="$MOBILE_ROOT/android/app/src/main/AndroidManifest.xml"
GRADLE="$MOBILE_ROOT/android/app/build.gradle.kts"
APK_DEBUG="$MOBILE_ROOT/build/app/outputs/flutter-apk/app-debug.apk"

AAR="$MOBILE_ROOT/android/app/libs/sherpa-onnx.aar"
if [[ -f "$AAR" ]]; then
  ok "Sherpa AAR 存在"
else
  err "缺少 Sherpa AAR: apps/mobile-flutter/android/app/libs/sherpa-onnx.aar"
  add_todo "执行: cp /Users/studio/Documents/GitHub/voice2text/modules/sherpa/android/libs/sherpa-onnx.aar apps/mobile-flutter/android/app/libs/sherpa-onnx.aar"
fi

CONTRACT_DART="$MOBILE_ROOT/lib/app/contracts/audio_contract.dart"
CONTRACT_KT="$MOBILE_ROOT/android/app/src/main/kotlin/com/voice2text/app/contracts/AudioContract.kt"
KEY_PROPS="$MOBILE_ROOT/android/key.properties"
KEY_EXAMPLE="$MOBILE_ROOT/android/key.properties.example"

# 1) version
version_line="$(rg '^version:' "$PUBSPEC" || true)"
if [[ -z "$version_line" ]]; then
  err "pubspec.yaml 缺少 version 字段"
  add_todo "在 pubspec.yaml 增加版本号，例如: version: 1.0.1+2"
else
  version_value="${version_line#version: }"
  if [[ "$version_value" == "1.0.0+1" ]]; then
    warn "version 仍是默认值 1.0.0+1，发布前建议更新"
    add_todo "修改 pubspec.yaml: version: 1.0.1+2"
  else
    ok "version=$version_value"
  fi
fi

# 2) permission
if rg -q 'android.permission.RECORD_AUDIO' "$MANIFEST"; then
  ok "AndroidManifest 已声明 RECORD_AUDIO"
else
  err "AndroidManifest 缺少 RECORD_AUDIO 权限"
  add_todo "在 apps/mobile-flutter/android/app/src/main/AndroidManifest.xml 增加: <uses-permission android:name=\"android.permission.RECORD_AUDIO\" />"
fi

# 3) contracts
if [[ -f "$CONTRACT_DART" && -f "$CONTRACT_KT" ]]; then
  ok "Dart/Kotlin 契约文件存在"
else
  err "契约文件缺失（audio_contract.dart 或 AudioContract.kt）"
  add_todo "补齐 apps/mobile-flutter 下的 Dart/Kotlin 音频契约文件"
fi

if ./tool/check_audio_contract.sh >/dev/null 2>&1; then
  ok "音频契约一致性检查通过"
else
  err "音频契约一致性检查失败"
  add_todo "执行 ./tool/check_audio_contract.sh 并修复输出的 MISMATCH"
fi

if ./tool/check_runtime_contract.sh >/dev/null 2>&1; then
  ok "单一真实运行时契约检查通过"
else
  err "单一真实运行时契约检查失败"
  add_todo "执行 ./tool/check_runtime_contract.sh 并移除 Flavor、stub 或移动端实时入口残留"
fi

# 4) key templates and signing fields
if [[ -f "$KEY_EXAMPLE" ]]; then
  ok "key.properties.example 模板存在"
else
  err "缺少 apps/mobile-flutter/android/key.properties.example 模板"
  add_todo "创建 apps/mobile-flutter/android/key.properties.example 模板"
fi

if [[ -f "$KEY_PROPS" ]]; then
  ok "检测到 apps/mobile-flutter/android/key.properties"

  if rg -q '^applicationId=com.example.voice2text_flutter$' "$KEY_PROPS"; then
    warn "key.properties.applicationId 仍是默认示例值"
    add_todo "编辑 apps/mobile-flutter/android/key.properties: applicationId=com.yourcompany.voice2text"
  fi

  if rg -q '^storeFile=' "$KEY_PROPS" && rg -q '^storePassword=' "$KEY_PROPS" && rg -q '^keyAlias=' "$KEY_PROPS" && rg -q '^keyPassword=' "$KEY_PROPS"; then
    ok "key.properties 含签名必要字段"
  else
    err "key.properties 缺少签名字段（storeFile/storePassword/keyAlias/keyPassword）"
    add_todo "执行 ./tool/init_key_properties.sh 后补齐 storeFile/storePassword/keyAlias/keyPassword"
  fi

  if rg -q '^applicationId=com.yourcompany.voice2text$' "$KEY_PROPS"; then
    err "key.properties.applicationId 仍是模板占位值"
    add_todo "将 apps/mobile-flutter/android/key.properties 的 applicationId 改成你自己的包名"
  fi
  if rg -q '^storePassword=REPLACE_ME$' "$KEY_PROPS" || rg -q '^keyPassword=REPLACE_ME$' "$KEY_PROPS"; then
    err "key.properties 仍包含 REPLACE_ME 占位密钥"
    add_todo "将 apps/mobile-flutter/android/key.properties 的 storePassword/keyPassword 替换为真实值"
  fi
  if rg -q '^storeFile=/absolute/path/to/your-upload-keystore.jks$' "$KEY_PROPS"; then
    err "key.properties.storeFile 仍是模板占位路径"
    add_todo "将 apps/mobile-flutter/android/key.properties 的 storeFile 改为真实 keystore 绝对路径"
  fi
  store_file_val="$(rg '^storeFile=' "$KEY_PROPS" | head -1 | cut -d '=' -f2- || true)"
  if [[ -z "$store_file_val" ]]; then
    err "key.properties.storeFile 为空"
    add_todo "在 apps/mobile-flutter/android/key.properties 填写 storeFile 绝对路径"
  elif [[ ! -f "$store_file_val" ]]; then
    err "storeFile 指向的 keystore 不存在: $store_file_val"
    add_todo "确认 keystore 文件存在，并更新 apps/mobile-flutter/android/key.properties 的 storeFile"
  else
    ok "keystore 文件存在: $store_file_val"
  fi

  if rg -q '^storePassword=demo-store-password$' "$KEY_PROPS" || rg -q '^keyPassword=demo-key-password$' "$KEY_PROPS"; then
    err "key.properties 仍是 demo 密码，禁止用于发布"
    add_todo "执行 ./tool/set_signing_passwords.sh 写入真实签名密码"
  fi
else
  warn "未检测到 apps/mobile-flutter/android/key.properties，release 会回退 debug 签名"
  add_todo "执行 ./tool/init_key_properties.sh 生成 apps/mobile-flutter/android/key.properties"
fi

# 5) app id fallback check
if rg -q 'com.example.voice2text_flutter' "$GRADLE"; then
  if [[ -f "$KEY_PROPS" ]] && ! rg -q '^applicationId=com.example.voice2text_flutter$' "$KEY_PROPS"; then
    ok "build.gradle.kts 含 fallback 示例值，但 key.properties 已覆盖 applicationId"
  else
    warn "build.gradle.kts 含 fallback 示例 applicationId（未配置 key.properties 时会生效）"
  fi
else
  ok "build.gradle.kts 未包含示例 applicationId"
fi

# 6) apk artifact existence (informational)
if [[ -f "$APK_DEBUG" ]]; then
  size_kb=$(du -k "$APK_DEBUG" | awk '{print $1}')
  ok "debug APK 存在 (${size_kb}KB)"
else
  warn "debug APK 不存在，可先执行 flutter build apk --debug"
  add_todo "执行 flutter build apk --debug"
fi

# 7) baseline quality gates
if (cd "$MOBILE_ROOT" && flutter analyze >/dev/null 2>&1); then
  ok "flutter analyze 通过"
else
  err "flutter analyze 未通过"
  add_todo "执行 flutter analyze 并修复错误"
fi

if (cd "$MOBILE_ROOT" && flutter test >/dev/null 2>&1); then
  ok "flutter test 通过"
else
  err "flutter test 未通过"
  add_todo "执行 flutter test 并修复失败用例"
fi

# 8) audio product-loop and privacy boundaries
if [[ -f "$MOBILE_ROOT/integration_test/audio_offline_flow_test.dart" ]] &&
   [[ -f "$MOBILE_ROOT/integration_test/audio_recovery_flow_test.dart" ]] &&
   [[ -x "$ROOT/tool/run_audio_flow_smoke.sh" ]]; then
  ok "音频离线流、恢复流和真机脚本存在"
else
  err "音频产品闭环集成测试或真机脚本缺失/不可执行"
  add_todo "补齐 apps/mobile-flutter/integration_test/audio_*_flow_test.dart 并 chmod +x tool/run_audio_flow_smoke.sh"
fi

if ./tool/check_privacy_contract.sh >/dev/null 2>&1; then
  ok "隐私、备份、分享边界与日志契约检查通过"
else
  err "隐私、备份、分享边界或日志契约检查失败"
  add_todo "执行 ./tool/check_privacy_contract.sh 并修复输出"
fi

if python3 tool/validate_s3_productization_scope.py >/dev/null 2>&1; then
  ok "S3 产品状态契约一致"
else
  err "S3 产品状态契约不一致"
  add_todo "执行 python3 tool/validate_s3_productization_scope.py 并修复状态或证据漂移"
fi

s3_status="$(
  python3 - <<'PY'
import json
from pathlib import Path
scope = json.loads(Path("docs/product/s3-productization-scope.json").read_text(encoding="utf-8"))
print(scope["fullS3"]["status"])
PY
)"
if [[ "$s3_status" == "PASS" ]]; then
  ok "完整 S3 门禁通过"
else
  err "完整 S3 仍为 $s3_status"
  add_todo "另立说话人候选/分块架构准入计划，完成 PC runtime/adapter 和多语言门禁；不得用第一增量替代完整 S3"
fi

asr005_status="$(
  python3 - <<'PY'
import json
from pathlib import Path
scope = json.loads(Path("docs/product/s3-productization-scope.json").read_text(encoding="utf-8"))
print(scope["asr005"]["status"] + "/" + scope["asr005"]["executionDisposition"])
PY
)"
if [[ "$asr005_status" == "PASS/PASS" ]]; then
  ok "ASR-005 独立时间戳门禁通过"
else
  err "ASR-005 仍为 $asr005_status"
  add_todo "由独立 reviewer 完成 ASR-005 正常模式听审；人工执行跳过不等于 PASS"
fi

timestamp_result="$(
  python3 benchmark/evaluate_transcript_timestamps.py \
    --predictions benchmark/audio/timestamp_evaluator_selftest_predictions.json \
    --allow-provisional 2>/dev/null || true
)"
if [[ "$timestamp_result" == *'"releaseEligible": true'* ]] ||
   [[ "$timestamp_result" == *'"releaseEligible":true'* ]]; then
  ok "时间戳 benchmark 使用独立批准标注并满足发布门槛"
else
  warn "时间戳 benchmark 仍非 release-eligible"
  add_todo "完成独立听审标注、真机预测并使 P95 边界误差 <= 1.5 秒"
fi

echo
if [[ ${#TODOS[@]} -gt 0 ]]; then
  echo "TODO Checklist:"
  i=1
  for item in "${TODOS[@]}"; do
    echo "  $i. $item"
    i=$((i+1))
  done
  echo
fi

if [[ "$failures" -gt 0 ]]; then
  echo "Preflight result: FAILED ($failures errors, $warns warnings)"
  exit 1
fi

echo "Preflight result: PASS ($warns warnings)"
