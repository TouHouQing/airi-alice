---
title: A.L.I.C.E 开发需求文档（Epoch 1）
description: 面向开发团队的 Epoch 1 任务级执行清单
---

# A.L.I.C.E 开发需求文档（Epoch 1）

## 1. 文档定位

本文档仅覆盖 Epoch 1，目标是让工程师不需要二次决策即可开工。

- 适用范围：`stage-tamagotchi` 优先。
- 非目标：Epoch 2-5 的 Live2D、TTS、多模态感知、预测执行等能力。
- 任务编号：`ALICE-E1-T001` 起。

## 2. Epoch 1 交付基线

必须交付：

1. 初始化配置持久化（ALICE-F1.1）。
2. Personality Matrix v0（ALICE-F1.2）。
3. 每轮结构化输出 `thought/emotion/reply`（ALICE-F2.2）。
4. 短期事实记忆写入/检索（ALICE-F1.3 基础）。
5. 本地隐私、Kill Switch、审计链路（NFR）。

## 3. 任务清单（开发即执行）

### ALICE-E1-T001 品牌层改名边界与 Alice 入口模块

- 关联需求ID：`ALICE-NFR-ENG-001`、`ALICE-NFR-ENG-002`
- 关联架构章节：`1`、`2`、`10`
- 背景/目标：在不破坏上游 AIRI 核心结构的前提下，建立 `alice` 域入口与可持续同步边界。
- 输入输出与接口：
  - 输入：当前 monorepo 主干结构。
  - 输出：`alice` 域文档入口、配置入口、模块目录骨架。
  - 接口：`apps/stage-tamagotchi/src/main/services/alice/index.ts` 对外暴露初始化函数。
- 影响模块：`apps/stage-tamagotchi`、`packages/stage-shared`、`packages/i18n`。
- 前置依赖：无。
- 实现步骤：
  1. 建立 `alice` 域目录与导出入口。
  2. 将品牌化配置放到独立配置文件，不改写上游核心常量。
  3. 在主进程注入点增加 `alice` 模块装配逻辑。
- 测试点：
  1. 启动时 `alice` 模块可被正常加载。
  2. 不启用 `alice` 时原 AIRI 行为不受影响。
- 完成定义（DoD）：
  - 有独立入口模块。
  - 无跨域硬编码引用。
  - 文档中说明上游同步边界。
- 风险与回滚点：
  - 风险：目录调整影响现有导入路径。
  - 回滚：保留原入口并通过 feature flag 切回。

### ALICE-E1-T002 事件总线最小契约与 Topic 常量

- 关联需求ID：`ALICE-DEP-001`、`ALICE-NFR-ENG-003`
- 关联架构章节：`4.1`、`4.2`、`4.3`
- 背景/目标：统一 Epoch 1 内部通信，避免模块直接耦合。
- 输入输出与接口：
  - 输入：对话、初始化、安全事件需求。
  - 输出：类型化事件信封、Topic 常量、发布订阅接口。
  - 接口：`publish(event)`、`subscribe(topic, handler)`。
- 影响模块：`apps/stage-tamagotchi/src/shared/alice`、`packages/stage-shared/src/alice`。
- 前置依赖：`ALICE-E1-T001`。
- 实现步骤：
  1. 定义 `AliceEvent` 类型与 topic 命名规范。
  2. 实现最小发布订阅层（进程内即可）。
  3. 增加审计钩子，关键 topic 自动落审计。
- 测试点：
  1. 同一 topic 多订阅者可同时接收。
  2. 非法 topic 在开发环境抛出错误。
  3. Kill Switch 事件可全局广播。
- 完成定义（DoD）：
  - Topic 常量统一来源。
  - 无字符串散落硬编码。
  - 事件类型可被 TypeScript 推断。
- 风险与回滚点：
  - 风险：事件风暴导致调试困难。
  - 回滚：保留直接调用路径作为临时降级开关。

### ALICE-E1-T003 初始化流程与配置持久化

- 关联需求ID：`ALICE-F1.1`
- 关联架构章节：`8.1`、`9.1`、`6.2`
- 背景/目标：实现首次启动参数采集和本地持久化，形成会话基线人格。
- 输入输出与接口：
  - 输入：`hostName`、`mindAge`、`personalitySeed`。
  - 输出：`profileId`、初始化完成事件。
  - 接口：`initializeAlice(input)`。
- 影响模块：`main/services/alice/onboarding`、`shared/alice/contracts`。
- 前置依赖：`ALICE-E1-T001`、`ALICE-E1-T002`。
- 实现步骤：
  1. 定义初始化 Schema（Valibot）。
  2. 写入本地数据库并返回 `profileId`。
  3. 发布 `alice.onboarding.completed`。
- 测试点：
  1. 输入越界值时校验失败。
  2. 重启后读取同一 profile。
  3. 初始化完成事件 payload 正确。
- 完成定义（DoD）：
  - 可重复初始化但不会产生脏状态。
  - 初始化数据可用于后续对话流程。
- 风险与回滚点：
  - 风险：重复初始化导致多 profile 冲突。
  - 回滚：启用单 profile 锁并提供重置脚本。

### ALICE-E1-T004 Personality Matrix v0 状态机

- 关联需求ID：`ALICE-F1.2`
- 关联架构章节：`5.1`、`6.2`
- 背景/目标：实现慢速、可累计、可持久化的人格漂移。
- 输入输出与接口：
  - 输入：用户反馈信号、任务结果信号。
  - 输出：更新后人格向量。
  - 接口：`updatePersonality(signal)`、`getPersonality(profileId)`。
- 影响模块：`main/services/alice/personality`、`packages/stage-shared/src/alice`。
- 前置依赖：`ALICE-E1-T003`。
- 实现步骤：
  1. 定义人格维度和阈值常量。
  2. 实现 `delta` 限幅逻辑（单轮 <= 0.02）。
  3. 落库并发布状态变更事件。
- 测试点：
  1. 连续 100 轮更新无跳变。
  2. 越界更新会被截断。
  3. 冷启动后人格状态一致。
- 完成定义（DoD）：
  - 漂移可解释（有更新原因日志）。
  - 人格参数可被对话编排读取。
- 风险与回滚点：
  - 风险：漂移过快造成角色失真。
  - 回滚：关闭漂移写入，仅保留只读人格。

### ALICE-E1-T005 对话编排主链路（Orchestrator）

- 关联需求ID：`ALICE-F1.1`、`ALICE-F2.2`
- 关联架构章节：`3`、`5.2`、`9.2`
- 背景/目标：建立 Epoch 1 核心会话链路，串起输入、记忆、人格与模型调用。
- 输入输出与接口：
  - 输入：`DialogueRequest`。
  - 输出：`DialogueResponse`。
  - 接口：`handleDialogue(request)`。
- 影响模块：`main/services/alice/orchestrator`。
- 前置依赖：`ALICE-E1-T002`、`ALICE-E1-T003`、`ALICE-E1-T004`。
- 实现步骤：
  1. 聚合 profile、人格、短期记忆构造上下文。
  2. 调用模型网关并拿到原始响应。
  3. 交给结构化解析器，失败时走回退。
  4. 发布 `alice.dialogue.responded`。
- 测试点：
  1. 正常路径返回完整结构体。
  2. 模型超时时可返回降级回复。
  3. 链路中任一子模块失败不会崩溃。
- 完成定义（DoD）：
  - 主链路可连续稳定运行。
  - 错误路径覆盖并可观测。
- 风险与回滚点：
  - 风险：链路耦合过高难以扩展。
  - 回滚：保留分段调用开关，支持逐段排障。

### ALICE-E1-T006 结构化输出解析器与回退策略

- 关联需求ID：`ALICE-F2.2`
- 关联架构章节：`5.2`、`9.2`
- 背景/目标：强制每轮响应生成 `thought/emotion/reply`，解析失败可回退。
- 输入输出与接口：
  - 输入：模型原始文本。
  - 输出：标准化 `DialogueResponse`。
  - 接口：`parseStructuredReply(raw)`。
- 影响模块：`main/services/alice/orchestrator/parsers`。
- 前置依赖：`ALICE-E1-T005`。
- 实现步骤：
  1. 定义结构化 JSON schema。
  2. 实现解析与字段兜底规则。
  3. 为 `emotion` 提供白名单映射。
- 测试点：
  1. 合法 JSON 全字段解析通过。
  2. 缺失字段时自动补默认值。
  3. 非法输出不阻断主流程。
- 完成定义（DoD）：
  - 解析成功率满足验收阈值。
  - 回退路径可审计。
- 风险与回滚点：
  - 风险：模型输出漂移导致解析波动。
  - 回滚：启用纯文本回复模式并标记 `emotion=neutral`。

### ALICE-E1-T007 短期事实记忆抽取与写入

- 关联需求ID：`ALICE-F1.3`
- 关联架构章节：`6.2`、`9.2`
- 背景/目标：从对话轮中抽取事实三元组，形成可检索短期记忆。
- 输入输出与接口：
  - 输入：用户文本、回复文本。
  - 输出：`memoryWrites[]`。
  - 接口：`extractFacts(turn)`、`upsertFacts(facts)`。
- 影响模块：`main/services/alice/memory`。
- 前置依赖：`ALICE-E1-T005`。
- 实现步骤：
  1. 定义三元组结构和置信度字段。
  2. 实现抽取规则（先规则后模型）。
  3. 写入 `alice_memory_facts` 并发布事件。
- 测试点：
  1. 用户偏好类事实可正确抽取。
  2. 重复事实执行 upsert 而非重复插入。
  3. 低置信度事实可过滤。
- 完成定义（DoD）：
  - 单轮记忆写入可控且可追踪。
  - 事实表可被检索模块使用。
- 风险与回滚点：
  - 风险：误抽取造成脏记忆。
  - 回滚：关闭自动抽取，仅保留人工确认写入。

### ALICE-E1-T008 短期记忆检索注入

- 关联需求ID：`ALICE-F1.3`
- 关联架构章节：`6.2`、`9.2`
- 背景/目标：在对话前检索相关事实并注入上下文。
- 输入输出与接口：
  - 输入：当前用户输入 + 会话信息。
  - 输出：排序后的记忆片段列表。
  - 接口：`retrieveFacts(queryContext)`。
- 影响模块：`main/services/alice/memory/retriever`、`orchestrator`。
- 前置依赖：`ALICE-E1-T007`。
- 实现步骤：
  1. 定义检索排序（时间衰减 + 置信度）。
  2. 设置注入条目上限与 token 预算。
  3. 将命中事实写入调试日志。
- 测试点：
  1. 命中率在典型场景下可接受。
  2. 长会话下 token 不超预算。
  3. 无命中时可平滑退化。
- 完成定义（DoD）：
  - 检索结果稳定且可解释。
  - 上下文注入不破坏响应时延。
- 风险与回滚点：
  - 风险：检索噪音影响回复质量。
  - 回滚：降低注入上限或关闭记忆注入开关。

### ALICE-E1-T009 本地存储与数据访问层（DAO）

- 关联需求ID：`ALICE-NFR-PRIV-001`、`ALICE-DEP-002`
- 关联架构章节：`6.1`、`6.2`
- 背景/目标：建立统一本地数据访问层，防止各模块直接写库造成混乱。
- 输入输出与接口：
  - 输入：profile、turn、fact、audit 数据对象。
  - 输出：统一 DAO API。
  - 接口：`profileDao`、`memoryDao`、`conversationDao`、`auditDao`。
- 影响模块：`main/services/alice/storage`。
- 前置依赖：`ALICE-E1-T003`、`ALICE-E1-T007`。
- 实现步骤：
  1. 创建表结构与迁移脚本。
  2. 封装 DAO，禁止业务层直写 SQL。
  3. 增加基础数据清理策略接口（保留默认本地）。
- 测试点：
  1. 迁移可重复执行。
  2. DAO 异常会返回可诊断错误。
  3. 并发读写不出现数据损坏。
- 完成定义（DoD）：
  - 数据操作统一收敛到 DAO。
  - 关键表具备迁移与回滚脚本。
- 风险与回滚点：
  - 风险：迁移失败导致启动失败。
  - 回滚：保留上一版 schema，支持自动降级读取。

### ALICE-E1-T010 脱敏网关与云调用防护

- 关联需求ID：`ALICE-NFR-PRIV-002`、`ALICE-NFR-PRIV-003`
- 关联架构章节：`7.1`
- 背景/目标：任何云模型调用前执行脱敏与审计。
- 输入输出与接口：
  - 输入：原始 prompt/context。
  - 输出：脱敏后的 payload + 脱敏报告。
  - 接口：`sanitizeForRemoteModel(input)`。
- 影响模块：`main/services/alice/security`、`orchestrator`。
- 前置依赖：`ALICE-E1-T005`。
- 实现步骤：
  1. 定义敏感模式规则（token/password/key）。
  2. 执行替换并生成脱敏 diff 摘要。
  3. 将脱敏过程写入审计日志（不记录原始敏感值）。
- 测试点：
  1. 常见密钥格式可识别并替换。
  2. 误杀率可接受。
  3. 脱敏失败时默认阻断外发。
- 完成定义（DoD）：
  - 云调用必须经过网关。
  - 审计中不泄露敏感原文。
- 风险与回滚点：
  - 风险：误杀导致回复质量下降。
  - 回滚：启用规则分级并支持白名单配置。

### ALICE-E1-T011 Kill Switch 全链路

- 关联需求ID：`ALICE-NFR-SAFE-001`、`ALICE-NFR-SAFE-003`
- 关联架构章节：`5.3`、`7.3`、`9.3`
- 背景/目标：提供硬中断能力，能瞬时切断感知探针与执行权。
- 输入输出与接口：
  - 输入：快捷键事件或命令口令。
  - 输出：系统状态 `ACTIVE/SUSPENDED`。
  - 接口：`suspend(reason)`、`resume(reason)`、`getState()`。
- 影响模块：`main/services/alice/safety`、`shared/alice/contracts`。
- 前置依赖：`ALICE-E1-T002`。
- 实现步骤：
  1. 在主进程注册 Kill Switch 触发器。
  2. 广播 kill-switch 事件并停用相关模块。
  3. 增加恢复流程与状态查询。
- 测试点：
  1. 触发后执行链路立即拒绝请求。
  2. 恢复后可继续正常对话。
  3. 连续触发/恢复不出现状态漂移。
- 完成定义（DoD）：
  - 中断耗时在目标阈值内。
  - 状态可观测且可恢复。
- 风险与回滚点：
  - 风险：中断不彻底导致安全隐患。
  - 回滚：进入只读安全模式并提示重启。

### ALICE-E1-T012 审计日志与最小观测能力

- 关联需求ID：`ALICE-NFR-PRIV-003`、`ALICE-NFR-SAFE-002`
- 关联架构章节：`4.3`、`6.2`、`7`
- 背景/目标：关键行为可追踪，为问题定位和后续合规打基础。
- 输入输出与接口：
  - 输入：事件总线关键事件。
  - 输出：结构化审计记录。
  - 接口：`recordAudit(event, level)`、`queryAudit(filter)`。
- 影响模块：`main/services/alice/audit`。
- 前置依赖：`ALICE-E1-T002`、`ALICE-E1-T009`。
- 实现步骤：
  1. 设计审计等级与字段。
  2. 订阅关键事件并落库。
  3. 提供调试查询接口（开发态）。
- 测试点：
  1. 初始化、对话、Kill Switch 均有审计。
  2. 审计查询支持按 `traceId` 过滤。
  3. 高并发下日志不丢失。
- 完成定义（DoD）：
  - 关键链路可完整回放。
  - 审计数据不包含敏感明文。
- 风险与回滚点：
  - 风险：日志过量导致磁盘膨胀。
  - 回滚：启用日志级别和保留策略限制。

### ALICE-E1-T013 集成验证与交付门禁

- 关联需求ID：`ALICE-EPOCH-1`、`ALICE-NFR-PERF-001`、`ALICE-NFR-PERF-002`
- 关联架构章节：`3`、`4`、`8.1`
- 背景/目标：将 Epoch 1 能力串成可验收基线，形成 CI 可执行门禁。
- 输入输出与接口：
  - 输入：前 12 个任务产物。
  - 输出：测试报告、验收报告、回归脚本。
  - 接口：`pnpm lint:fix`、`pnpm typecheck`、目标 Vitest 套件。
- 影响模块：根目录 CI、`apps/stage-tamagotchi` 测试目录。
- 前置依赖：`ALICE-E1-T001` 至 `ALICE-E1-T012`。
- 实现步骤：
  1. 编写主链路集成测试（初始化 -> 对话 -> 记忆 -> Kill Switch）。
  2. 建立性能基线采样（空闲态 CPU、对话时延）。
  3. 汇总验收报告并冻结 M1 基线标签。
- 测试点：
  1. 端到端链路连续通过。
  2. Kill Switch 中断/恢复通过。
  3. 关键性能指标满足阈值。
- 完成定义（DoD）：
  - CI 门禁可稳定运行。
  - M1 验收报告可追溯到需求与架构。
- 风险与回滚点：
  - 风险：集成环境不稳定导致假失败。
  - 回滚：拆分 smoke 与 full test 两级门禁。

## 4. 任务依赖关系（执行顺序）

建议顺序：

1. `T001 -> T002 -> T003 -> T004`
2. `T005 -> T006`
3. `T007 -> T008`
4. `T009 -> T010 -> T011 -> T012`
5. `T013`

## 5. Epoch 1 明确不做

1. Live2D 与 TTS 表现层实现。
2. 屏幕截图、麦克风静默监听、VLM/Whisper 接入。
3. 预测性代办、自动学习工具链。
4. 生物钟成熟机制与跨端同步。
