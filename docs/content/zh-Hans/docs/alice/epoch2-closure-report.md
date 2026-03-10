---
title: A.L.I.C.E Epoch2 收官验收报告
description: Epoch2（M2.1/M2.2/M2.3）闭环门禁执行结果与追溯记录
---

# A.L.I.C.E Epoch2 收官验收报告（进行中）

## 1. 执行范围

- 目标版本：Epoch2 完整闭环施工计划（M2.1 + M2.2 + M2.3）
- 执行日期：2026-03-10
- 范围：`apps/stage-tamagotchi` + `packages/stage-ui`

## 2. 模块验收结论

1. M2.1 系统探针与静默注入：通过
主进程 `alice-sensory-bus` 以低频缓存采样系统状态，Runtime system 高内聚注入保持“SOUL Anchor + Runtime”两层结构，Budget 下优先压缩 sensory 段且 JSON 合约锚点保留。

2. M2.2 全息表现层桥接：通过
`alice.dialogue.responded` 只在结构化完成且 `conversation_turns` 成功落库后发射；Renderer 通过 Presence Dispatcher 按 `turnId` 去重、情绪白名单归一化、Live2D/TTS `Promise.allSettled` 并发降级。

3. M2.3 MCP + 人在回路：通过（门禁级）
完成三层读取漏斗、绝对黑名单硬拒绝、一次性 token + `requestId` 绑定校验、60s 超时拒绝、防重放、Kill Switch 对 pending/在途/会话生命周期硬中断。

## 3. 验证命令与结果

```bash
pnpm -F @proj-airi/stage-tamagotchi exec vitest run \
  src/main/services/alice/sensory-bus.test.ts \
  src/main/services/alice/runtime.test.ts \
  src/main/services/airi/mcp-servers/index.test.ts
# 结果：PASS（26 tests）
```

```bash
pnpm -F @proj-airi/stage-ui exec vitest run \
  src/stores/alice-presence-dispatcher.test.ts \
  src/stores/chat.test.ts \
  src/composables/alice-guardrails.test.ts \
  src/composables/alice-prompt-composer.test.ts
# 结果：PASS（21 tests）
```

```bash
pnpm exec eslint \
  apps/stage-tamagotchi/src/main/services/airi/mcp-servers/index.ts \
  apps/stage-tamagotchi/src/main/services/airi/mcp-servers/index.test.ts \
  apps/stage-tamagotchi/src/main/services/alice/runtime.ts \
  apps/stage-tamagotchi/src/main/services/alice/runtime.test.ts \
  apps/stage-tamagotchi/src/renderer/App.vue \
  apps/stage-tamagotchi/src/shared/eventa.ts \
  packages/stage-ui/src/components/scenes/Stage.vue \
  packages/stage-ui/src/stores/alice-presence-dispatcher.ts \
  packages/stage-ui/src/stores/alice-presence-dispatcher.test.ts
# 结果：PASS
```

## 4. 关键断言覆盖

1. M2.1
- 1500ms 探针超时与失败降级不阻断对话。
- 10k 预算回归中 `system[0]` SOUL 锚点不变。

2. M2.2
- 非法 emotion 归一化为 `neutral` 且保留 `rawEmotion`。
- 落库失败或中断轮不发 `alice.dialogue.responded`。

3. M2.3
- 黑名单路径直接拒绝且无弹窗。
- 工作区内读取静默放行，工作区外读取进入 HitL。
- token 单次消费、防重放；`requestId` 与 token 绑定校验。
- 权限超时、用户拒绝、Kill Switch 中断均返回结构化错误，不抛异常打断主循环。
- 目录穿越样本（`../`）无法绕过漏斗。

## 5. 未决项与非阻断环境噪音

1. 根级 `pnpm typecheck` 仍受仓库既有问题影响（`server-runtime` 类型错误、volar ESM 警告等），不属于本次 Epoch2 Alice 变更引入。
2. 根级 `pnpm lint:fix` 仍受 `oxlint` native binding 缺失与仓内历史 lint 问题影响。
3. `stage-tamagotchi` 全量构建与打包产物记录需在最终收官阶段补执行并附时间戳。

## 6. 下一阶段收官清单

1. 执行 `stage-tamagotchi build` 与 `build:mac`，补录产物路径与时间戳。
2. 增加一次端到端人工回放记录（权限弹窗拒绝、Kill Switch 中断在途工具、恢复后继续对话）。
3. 将本报告“进行中”升级为“最终版”，冻结 Epoch2 基线。
