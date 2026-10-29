# 交接：线索触发回忆 + 钩子并行

> 2026-10-29 · 状态：设计已定，未开工 · 涉及仓库：fold-recall、dsh-hoos（`D:\work\huanghao\dsh-hoos`，即 dsh-codex-hooks）

## 一句话

**要改的：**
- fold-recall 不再每轮都停下来问决策模型"要不要回忆"，改成两条路：
  - 线索强时，本地直接给一行指引。
  - 需要挑选时，在后台问模型，结果下一步再注入。
- dsh-hoos 同一事件的同步钩子改成并行执行，跟 Codex 一致。

**目标：** 每轮第一步的等待，从现在的"所有钩子耗时之和，经常 2–6 秒"降到"最慢那个钩子，约 0.1 秒"，同时不漏回忆。

---

## 1. 为什么要改（实测）

### 1.1 fold-recall 第一步太慢，而且白等

数据来自 `~/.fold-recall/state.db` 的 `decisions` 表，截至 2026-10-29：

| 指标 | 值 |
|---|---|
| 每轮第一步耗时 | 中位 1.7 s，P90 约 6.1 s，最大 6.9 s（`FOLD_RECALL_TIMEOUT_MS=6000`） |
| 判断次数 | 38 |
| 其中问了决策模型 | 24 |
| 其中超时 | 6 |
| **真的回忆了** | **0** |
| 问模型的等待合计 | 约 74 s |

其余步骤（`firstStepOnly` 已经去掉，见 3.4）每步只查一次有没有压缩，约 0.06 s，可以忽略。

### 1.2 dsh-hoos 串行执行，耗时相加

`dsh-hoos/lib/index.js:363` 的 `runEvent` 用 `for` 循环逐个 `await executeHook`，同一事件的钩子一个跑完才跑下一个。一个真实项目每轮第一步要依次跑：
- fold-recall
- doc-drift（需求变更识别）
- Trellis（项目钩子，实测约 70 ms）
- Ponytail（实测约 43 ms）

所以 fold-recall 一慢，后面的钩子全都排队等着。

### 1.3 Codex 是并行的

官方文档 <https://learn.chatgpt.com/docs/hooks> 原文：

> Multiple matching command hooks for the same event are launched concurrently, so one hook can't prevent another matching hook from starting.

dsh-hoos 的目标是跟 Codex 行为一致，现在这一点不一致。

---

## 2. 设计依据：人什么时候回忆

1. **大多数回忆是线索勾起的，不是主动搜的**：Berntsen 关于"不由自主的自传体记忆"的研究，见 2021 年综述、Berntsen et al. 2013。
   - 当前情境的某个特征和过去某件事重合，那件事就会自己冒出来。
   - **线索越独特越有效**：普通椅子勾不起什么，"缺了扶手的橙色椅子"会勾出某一次特定的经历。
2. **线索勾起的回忆是自动的、不打断手头的事**：边做边想起，想起来再用上。
3. **刻意回忆只在知道自己要找时发生**：比如"上次那个后来怎么样了"，这时才会停下来认真搜。
4. **一直盯着要付代价**：McDaniel & Einstein 的多过程框架，以及 Scullin et al. 2013 的动态多过程框架。持续留意会拖慢手头的任务，人只在预期线索会出现时才盯，平时靠线索自然触发（概率性的自发提取）。

对应到 fold-recall：
- **默认不问模型。**
- **独特线索走本地快速路径。**
- **明确在找旧事，或者线索对应多处、需要挑选时，才问模型，而且在后台问。**

---

## 3. fold-recall 改动

### 3.1 每轮第一步（带用户消息的那一步）：只做本地计算，不等网络

保留：
- 提起计数（`M.mentioned`）
- 遗忘（有冷却）
- 续接快照检查（`J.continuation`）

`E.onPrompt` 里"问决策模型"的部分拆掉，换成下面的分流：

```
算候选（现有：二字组相关度 + 原文三字索引 + 下一段 + 最近最牢）
  │
  ├─ A. 独特线索直中 → 本地直接注入一行指引（不问模型）
  ├─ B. 有找旧事的意图，或线索对应多块需要挑 → 登记后台判断，本步不注入
  └─ C. 都不是 → 什么也不做（多数"继续 / 好的 / 按这个改"走这里）
```

**A. 独特线索直中**（对应"缺扶手的橙色椅子"）。规则先按下面写，阈值用 3.5 的回放来定：
- 命中了少见的词：英文标识符、文件名、报错原文、≥3 字的中文片段，并且该词逆文档频率排在前 10%，或在原文索引里的 df ≤ 3。
- 只强烈指向一块：第一名相关度 ≥ 0.5，并且 ≥ 第二名的 2 倍。原文命中按 `rawBlocks` 的覆盖率算，同样要求第一名明显领先。
- 这块不在当前上下文里：不是本会话里仍然激活的块。在眼前的东西不需要回忆。
- 注入沿用 `M.recallText`。偏好/约定、知识类照旧只给指引（`FOLD_RECALL_DEFER`）。

**B. 刻意回忆或需要挑选**：
- 意图句式（先用正则，后面可以调）：`上次|之前|前面|那次|当时|后来|最后(怎么样|结果|通了|合)|还记得|我们(定|说)的|原来的|老的`
- 或者 A 的条件只差"第一名领先"，也就是好几块都像。
- 满足任一条就登记一条后台判断（见 3.2），本步不注入。

**C**：什么也不做。

把压缩时机判断（`D.TIMING`）从第一步也挪出去：
- 它默认 `FOLD_RECALL_TIMING=off`，只记录。
- 要么合并进 B 的后台判断，要么在轮末钩子里做。
- 不能再让它把第一步拖成同步请求。

### 3.2 后台判断：不阻塞，下一步注入

- 第一步登记时，在状态库新建 `pending` 表：`(session_id, turn, created_at, prompt, cand_keys json, status, result json)`。
- 然后用分离进程启动 `fold-recall decide <session> <turn>`，写法照抄 `spawnConsolidate`：`detached + unref`，不等它。
- `decide` 子命令的流程：
  1. 读 `pending`，重新载入候选。
  2. 问 `recall` / `latest` 两道题，现有 `D.recallQuestion` / `D.recallPick`，超时可以放宽到 20–30 s，因为已经不挡对话。
  3. 结果写回 `result`，`status=done`，同时写 `decisions` 记录，保持 `report` 可用。
- 之后每一步（钩子本来就每步都跑），在 `J.continuation` 旁边加一步：
  1. 查本会话有没有 `status=done` 且未投递的结果。
  2. 有就注入 `recallText`，标记 `delivered`，再记一次"回忆"事件，强度照旧加。

**这一轮已经结束、结果才到怎么办**（模型一步就答完，没有第二步）：
- 下一轮第一步可以投递，但要重新算一下：这块和新消息的相关度 > 0 才投，否则丢掉。
- 超过 10 分钟的结果直接作废。

**同一轮只登记一次。** 后台判断还没回来时，后续步骤不要重复登记。

### 3.3 不变的部分

- 整理（`consolidate`）
- 遗忘
- 原文索引补全
- 分工（`FOLD_RECALL_DEFER`）
- 作废（`supersede`）
- 续接快照

### 3.4 关于 `firstStepOnly`

- **现在：** fold-recall 的 `agent/pre-step` **没有** `firstStepOnly`，是有意去掉的。
- **原因：** 一轮中间发生压缩时要补续接快照，每步代价约 0.06 s。改完 3.2 之后，每步还多一个"投递后台结果"的用途，更不能加回去。
- **长期替代：** 见 4.2，让 dsh-hoos 暴露"压缩完成"事件。

### 3.5 验收

1. **回放：** 用 `decisions` 表里这 38 条真实消息，加上 `recall` 评测题（README 里写的 27 题，题目文件不在仓库里，需要重新出题），统计新规则下 A、B、C 各走了多少次，以及评测题的命中率不能下降。
2. **耗时：** 第一步的钩子耗时，不含 node 启动，P90 < 300 ms。用 `decisions.total_ms` 或钩子统计弹窗看。
3. **后台路径：** 自测里用假决策接口模拟 15 s 延迟：
   - 第一步不注入；
   - 下一步注入；
   - 同一轮不重复登记；
   - 过期作废。
4. **原有 16 项自测全过：** `node test/selftest.mjs`。

---

## 4. dsh-hoos 改动

### 4.1 同步钩子并行

位置：`lib/index.js` 的 `runEvent`。

- **改成并行：** 把非 `async` 的钩子一次全部启动（`Promise.all`）。`this.log.start` / `finish` 每个钩子照记，统计弹窗的"运行中"计数靠它。
- **结果顺序：** 按配置顺序合并，不按完成顺序。`additionalContext` 拼接顺序要稳定，否则会破坏模型的提示词缓存。
- **拦截语义：** 任何一个返回 blocked 就算拦截。`approval/request` 里 deny 压过 allow，这一条已有，保持。
- **`async: true` 后台钩子：** 不变。
- **新增测试：**
  - 两个各睡 1 s 的钩子，总耗时约 1 s 而不是 2 s；
  - `additionalContext` 顺序等于配置顺序；
  - 一个拦截、一个放行时结果是拦截；
  - 一个超时不影响另一个出结果。
- **文档：** README 中英文里"执行"那一节补一句"同一事件的同步钩子并行启动，与 Codex 一致"。

### 4.2 后续：暴露"压缩完成"事件（可选，工作量较大）

- **现状：** DSH 插件层有 `compaction/start` / `compaction/end` 事件，dsh-mac-keep-awake 插件就在用。
- **做法：** dsh-hoos 可以把 `compaction/end` 映射成钩子事件，对应 Codex 的 `PostCompact`，或 `SessionStart` 带 `source: "compact"`。Codex 的做法是压缩后在下一次模型请求前运行，一轮中间的压缩也立即补上下文。
- **好处：** fold-recall 的续接快照就能改用这个事件，`pre-step` 再加回 `firstStepOnly`，3.2 的投递也可以挪到这里。
- **前提：** 先确认 DSH 插件 API 能在 `compaction/end` 里拿到会话、并向下一次请求注入内容。

---

## 5. 相关但不在本次范围

- **DSH「自动审查」权限模式：**
  - 每次工具调用多一次完整上下文的审查请求，串行，10–15 s。
  - 实测审查请求只命中 4992 个缓存 token，主会话因此 400 万 token 未命中。
  - 已整理成给 DSH 的 issue 草稿，**未提交**，在会话 scratchpad 的 `dsh-issue-auto-review.md`，需要 huashu-chrome 重连后用浏览器提交。
  - 建议多智能体长任务不要用自动审查。
- **DSH 关掉 rea MCP：** 约 190 个工具，工具定义占上下文 64%。用户已同意，要等 DSH 完全退出后再改 `~/.dsh/profiles/desktop/cordis.patch.yml`（先备份）。
- **doc-drift 的 pre-step 钩子耗时还没测。**
- **钩子注入内容不显示成用户气泡：** dsh-hoos 已有远端提交 `0c228dd`（`source: { kind: 'dsh-codex-hooks', form: 'context' }`），本地已同步，需要重启 DSH 生效。
  - 注意：DSH 聊天界面遇到不认识的 `form` 会抛错（`unreachable context form`），已知的有 instructions / catalog / snapshot / notice / relay / recall / null。
  - 远端提交说明写的是"已在桌面版验证 `context` 正常"。如果重启后聊天界面报错，就改成 `instructions`。

## 6. 文件索引

| 位置 | 内容 |
|---|---|
| `fold-recall/lib/engine.mjs` `onPrompt` | 本次主要改动点：拆出决策请求，加 A/B/C 分流 |
| `fold-recall/lib/memory.mjs` `score` / `candidates` / `rawBlocks` / `recallText` | 候选与相关度，A 的判定在这里加 |
| `fold-recall/lib/rawindex.mjs` | 原文三字索引，`usefulTerms` 给出词的 df |
| `fold-recall/lib/decide.mjs` | 决策接口与 `recall` / `latest` 题目 |
| `fold-recall/lib/journal.mjs` `continuation` | 每步都跑的入口，后台结果投递挂在它旁边 |
| `fold-recall/lib/store.mjs` | 状态库表结构，新增 `pending` |
| `fold-recall/bin/fold-recall.mjs` `hook` / `spawnConsolidate` | 钩子入口；后台进程写法参考 |
| `dsh-hoos/lib/index.js:363` `runEvent` | 改并行 |
| `dsh-hoos/test/run-tests.mjs`、`selftest/host-e2e.mjs` | 测试（现在 103 + 20 项全过） |
