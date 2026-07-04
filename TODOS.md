# TODOS

## P0（阻塞迁移完成判定）

- [x] 修复 R6：来电/系统中断后恢复提示未稳定出现
  - What: 修复录音中断后“自动停止并保存”提示链路
  - Why: 当前 R6=FAIL，直接阻塞第2项回归与第6项对齐结论
  - Evidence: docs/REAL_DEVICE_REGRESSION_MATRIX.md（R6）
  - Impl: `recording_page.dart` 在中断处理完成后立即尝试展示提示；若尚未恢复前台则缓存，恢复后再展示

- [x] 补齐 RN/Expo 对齐基线
  - What: 补齐录音/转写/设置/记录页的 RN 基线行为、文案、交互细节
  - Why: 目前对齐表多数“待补”，无法客观宣称迁移完成
  - Evidence: docs/EXPO_PARITY_GAP_TABLE.md
  - Progress: 已完成 RN 细节逐项对照，结论已收口为“已对齐”

## P1（验收与发布收口）

- [x] 完成回归矩阵剩余项 R2/R3/R4 并填表
  - What: 长录音、连续录音、失败重试完整回归与留证
  - Why: 第2项当前仅 DONE_WITH_CONCERNS，缺完整矩阵证据
  - Progress: R2/R3/R4 已完成并在矩阵标记 PASS；已补成功留证（logcat-20260507-092723）

- [x] 补齐状态流转与留证
  - What: 勾选 pending/processing/completed/failed，并补日志/截图
  - Why: 验收证据链未闭环
  - Progress: 已完成状态流转核对与留证，回归矩阵结论更新为 PASS

- [x] 修复 preflight_release 的契约路径检查
  - What: 使 ./tool/preflight_release.sh 与当前项目结构一致
  - Why: 当前 preflight 仍有 1 个错误，发布前检查不全绿
  - Impl: `tool/preflight_release.sh` 的 Kotlin 契约路径改为 `com/voice2text/app/contracts/AudioContract.kt`

## P2（质量优化）

- [x] 文案一致性与空态/加载态细节对齐
  - What: 对齐错误提示、空态文案、加载态表现
  - Why: 不阻断主链路，但影响迁移质量与体验一致性
  - Progress: 已完成关键文案与空态/加载态对齐，RN 细节全部确认
