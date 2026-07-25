# S2 privacy log evidence

- Captured: 2026-07-24 (Asia/Shanghai)
- Target: connected Xiaomi Android physical device (`M2102J2SC`)
- Build: current debug APK installed from this worktree
- Scope: app-generated structured startup events only

## Sanitized sample

```text
07-24 22:57:44.644 I/flutter: event=retention_scan_completed deleted=0 examined=0 failed=0 hasMore=false status=disabled
```

The line contains only an event category, counts, booleans, and an anonymous
status. It contains no meeting title, transcript text, private path, content
URI, error message, device serial, Android ID, or other stable device
identifier.

## Contract result

- `./tool/check_privacy_contract.sh`: pass
- Dart structured-log contract tests: pass
- Kotlin `PrivacySafeLogTest`: pass
- Android backup and device-transfer contract tests: pass

This evidence supports the logging and backup baseline only. It does not claim
application-layer encryption. The product-facing protection category remains
“由设备安全设置保护”.
