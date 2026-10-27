# fold-recall

**给长期运行的智能体一套像人一样的长期记忆：常用的记得牢，久不用的慢慢淡忘，重要的永远不忘，被问起时再想起来。**

它建立在 [billion-context](#前置条件) 的上下文折叠之上，用一个小型决策模型（默认 StartLux）做判断。零依赖，一个 Node 脚本，作为钩子挂进 DSH（或实验性地挂进 Claude Code）。

> English summary at the bottom.

---

## 目录

- [想达成什么效果](#想达成什么效果)
- [有哪些功能](#有哪些功能)
- [怎么设计的](#怎么设计的)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [会发给决策接口的内容](#会发给决策接口的内容)
- [实测结果](#实测结果)
- [测试指南](#测试指南)
- [路线图](#路线图)
- [局限与常见问题](#局限与常见问题)

---

## 想达成什么效果

越来越多人让一个智能体**长期跑着、不开新会话**：个人助理、监工、一直开着的编程会话。时间一长会出现三个问题：

| 问题 | 实际情况 |
|---|---|
| **旧东西一直占着上下文** | billion-context 会把历史折叠成摘要块，但摘要块本身越积越多。一个跑了约 9700 条消息的真实会话里，上下文中仍挂着 57 个摘要块，大半是早已结束的工作 |
| **该想起的想不起来** | 折叠前的原文都还在库里，但模型几乎从不主动调用 `decompress` / `search_context` 去找。我们检查过的会话里一次都没有 |
| **重要的和琐碎的一视同仁** | 用户定下的约定、方向性的决定，和一次性的排查过程，被同样地折叠、同样地淡忘 |

fold-recall 想让智能体的记忆**像人一样**：

- **最近一直提起的事，记得牢**；慢慢不提了，就慢慢变淡。
- **很淡的旧事不再占着上下文**，但没丢：被问起时自动去库里找回来。
- **重要的事永远不忘**：用户的偏好、约定、关键决定，由决策模型判断后钉住。
- **换话题时提醒压缩**，让上一件事的历史及时折叠起来。

最终效果是：智能体可以一直跑下去，上下文保持精简，而几天前、几千条消息之前的事，问起来仍然答得上。

---

## 有哪些功能

| 功能 | 做什么 | 什么时候发生 |
|---|---|---|
| **记忆强度** | 每个记忆块都有强度，随"之后又做了多少事"衰减，被提起或被找回时加强 | 每条用户消息 |
| **整理** | 决策模型给每个新记忆块判**类型**（偏好/约定、知识、过程、噪声）、**重要性**，以及它是哪段旧工作的**后续** | 后台进程，自动 |
| **钉住** | 偏好/约定，或重要性最高的约一成，永不遗忘 | 整理之后 |
| **遗忘** | 保持度掉到遗忘线以下的块，**后台直接**经 billion-context 的 `compress` 合成一个只列主题的索引块，拿出上下文；对话里不显示 | 每条消息检查，有冷却 |
| **回忆** | 新消息涉及某段旧事时，找回那一段，以及这件事**最新进展**的那一段，用一两行告诉模型 | 每条用户消息 |
| **压缩时机** | 判断是否换话题、上一件是否做完；默认**只记录不注入**（billion-context 自己会提醒压缩），可改为注入提示 | 每条用户消息，有冷却 |
| **试运行与报告** | 命令行查看记忆概况，或试一条消息"会找回什么" | 手动 |
| **继承修复** | 会话换了 id、折叠状态没接全时，把老会话已有的摘要套回来 | 手动（`repair`） |

**尽量不打扰对话**：对话里只会出现一两行 `[回忆]`；遗忘在后台做完，压缩时机只记在日志里，用 `report` 查看。任何一步失败或超时，**什么也不注入、什么也不改**。

---

## 怎么设计的

### 整体流程

```
用户发消息
   │
   ▼
钩子（DSH agent/pre-step 或 Claude Code UserPromptSubmit）
   │
   ├─ 读 billion-context 的库（只读）：同项目所有会话的记忆块、消息时钟、上下文用量
   ├─ 算每块的强度、与新消息的相关度
   ├─ 记"提起"：相关度高的几块各加强一次
   │
   ├─ 一次决策请求（最多一次）：
   │    · recall   需要找回哪段旧记忆？（≤24 个候选 + "都不需要"）
   │    · latest   如果在问进展/结果，最新进展在哪段？
   │    · done / shape / relation   上一件做完了吗？新消息是换话题吗？
   │
   ├─ 遗忘候选：不需要问模型，强度、类型、是否钉住都已算好
   │
   └─ 注入一段说明： [回忆] / [压缩时机] / [遗忘]
   
后台进程：整理新出现的记忆块（类型、重要性、前后关系），结果写入自己的状态库
```

### 记忆单元

记忆单元就是 billion-context 折叠出的**块**：一个主题、一段摘要、对应的原文范围。被合并掉的旧块（`active=0`）也还在库里，摘要更细，回忆时一样能用。

fold-recall **只读** billion-context 的库，自己的判断和事件存在单独的状态库 `~/.fold-recall/state.db` 里。

记忆的范围是**同一个项目**：DSH 同一工作区下的会话，或同一工作目录下被钩子见过的会话。

### 强度：越久不用越淡，越常用越牢

采用认知架构 ACT-R 的基础激活公式（强度形式）：

```
w = Σ  c_i · (age_i + 1) ^ -0.5
```

- `i` 包括：块的创建（c = 1）、每次被**提起**（c = 0.5）、每次被**找回**（c = 1）。
- `age` 是**之后又经过了多少条消息**，不是墙上时间。闲置几天不会让记忆变淡，之后又做了多少事才会。
- 同项目里之后新开的会话，消息数也计入（回忆排序用"项目时钟"）。

"提起"的判定：新消息与某块的字面相关度 ≥ 0.28、且命中 ≥ 2 个词，取最相关的 3 块。所以最近一直在聊的事，强度会一直被抬着。

### 重要性与钉住

后台整理时，对每个块问决策模型三道选择题：

| 题 | 选项 |
|---|---|
| **类型** | `preference` 用户的偏好、规则、长期指令或约定 · `knowledge` 项目事实、结论、决定、配置位置 · `episode` 一次性的工作过程 · `noise` 闲聊、确认 |
| **重要性** | `key` 以后必须一直记得 · `useful` 有参考价值 · `trivial` 用完即可忘 |
| **前一段** | 这段是不是接着下面某段更早的工作做的？（同会话上一块 + 字面相关的更早块，≤24 个）|

- **钉住**（永不遗忘）：类型为 `preference`，或 P(key) ≥ 0.8。实测决策模型认为大部分工作都"重要"（P(key) 中位数 0.55），所以钉住线定得高，只钉最重要的约一成。
- **没钉住的，越重要忘得越慢**：`保持度 = 强度 × (1 + P(key))`，噪声再减半。

### 遗忘：很淡的不进上下文

满足以下全部条件的块会被遗忘：

- 属于**当前会话**，且仍在上下文中；
- 类型是**过程**（episode）或**噪声**（noise）、未钉住。**知识、偏好/约定一律不忘**：忘错了模型察觉不到，它们留给 billion-context 自己的分层蒸馏去压；
- 这一轮没有被提起、没有被找回；
- **保持度 < 遗忘线**。遗忘线 = `1500^-0.5`，约等于"之后 1500 条消息都没用到"。

遗忘只按**本会话**经过的消息算：恢复一个旧会话时，它眼前的内容不会因为别的会话做了很多事而被挤掉。

**怎么忘**：fold-recall 按原文位置把连续的块合成段，自己调用 billion-context 的 `compress`（经它的插件接口），把每段换成一个只列主题的索引块：

```
m00001–m00806 旧工作索引（fold-recall 遗忘，5 段）
- b1「监工 session-6a3dc8b0（first pass）」2026-10-22
- b3「市场判定、命中率、GitHub 账号准备」2026-10-22
…
细节已移出上下文；需要时用 decompress 或 search_context 找回。
```

- 原来的块被嵌在索引块里（billion-context 的嵌套块），`decompress` 可以一层层展开；**原文仍完整保存在库里**，被问到时由回忆找回。
- 两个块之间如果还有没折叠的原始消息，就在那里断开，不把原文吞进索引。
- 每次最多 12 块，至少 3 块才动手，两次间隔 ≥ 300 条消息。
- 不想自动执行：`FOLD_RECALL_FORGET=hint` 改回"提示模型去做"，`off` 只记录。

### 回忆：被问起时再想起

1. **选候选**（最多 24 个），三个来源：
   - **字面相关的**：中文按相邻二字组、英文/标识符按词，逆文档频率加权。英文/标识符权重加倍（多是名字），命中主题的权重加倍，只出现一两次的二字组封顶。排序 = 相关度 × (0.5 + 0.5 × 归一化强度)，钉住的再 ×1.2。
   - **相关块的下一段**：问"最后怎么样了"时，答案常在后一段。
   - **最近最牢的几块**：人回忆时，最近的事先浮上来，即使字面上对不上。
   - 新消息里记忆库认得的词少于 2 个（如"继续""好的"），不做回忆。
2. **决策模型选**：`recall`（最需要找回哪段）和 `latest`（这件事最新的进展在哪段），共用同一组候选。
3. **接受条件**：选中段的概率 ≥ 0.5，**或**"都不需要"的概率 ≤ 0.05。第二个条件对应的情况是：确实需要旧记忆，只是相似的段太多，概率被摊薄了。
4. **带上最新进展**：`latest` 选中且概率 ≥ 0.4 的那段；否则沿整理得到的"后续"链走到最新一段，跳过噪声。
5. **怎么放回去**：
   - 本会话里仍在折叠中的块 → 一行：主题 + "要细节先 `decompress bN`"；
   - 已被合并/遗忘的块、其他会话的块 → 一行：主题、日期 + 摘要开头（≤400 字）。
6. 被找回的块记一次"回忆"，强度大幅提升，短期内不会再被遗忘。

### 压缩时机

沿用 compact-adviser 的两道原子题（逐字），再加一道"新请求与之前工作的关系"：

- `pNew` = 1 − P(继续同一项工作)；`S1` = P(完成) × (0.5 + 0.5 × P(动手做))；`S2` = S1 × pNew
- **换话题**：pNew ≥ 0.85。
- **做完换新**：S2 ≥ 0.5。
- 闸门：本会话第 3 轮起、上下文 ≥ 4 万 token、距上次判定 ≥ 3 轮。
- 默认**只记录**到 `decisions` 表（`report` 可看），不注入：billion-context 自己已经按增长提醒压缩，再加一段提示只会打扰对话。`FOLD_RECALL_TIMING=hint` 可改为注入提示（会要求摘要保留未完成事项）。

### 性能与可靠性

- **每条用户消息最多一次决策请求**：回忆题和时机题合在一起问，实测 1–3 秒，偶尔 5 秒以上。超过 6 秒就放弃，不注入。
- 整理在**分离的后台进程**里做，每次最多 40 块、并发 4，有锁防重复，不挡对话。
- DSH 的 `agent/pre-step` 每一步都会触发，同一轮只处理一次。
- 钩子里任何异常都吞掉，不打断宿主。

---

## 安装

### 前置条件

- **Node ≥ 22.5**（使用内置的 `node:sqlite`；零 npm 依赖）
- **billion-context** 正在为你的智能体做上下文折叠。它的库默认在 `~/.local/share/billion-context/sessions/index.db`
- **决策接口密钥**：默认 StartLux。也可以换成任何同形接口，见[配置](#配置)

### 1. 取代码

```sh
git clone https://github.com/matata2017/fold-recall.git
cd fold-recall
```

### 2. 配置密钥

放进环境变量 `FOLD_RECALL_API_KEY`（也认 `BAMBOO_API_KEY`），或写入 `~/.fold-recall/.env`：

```
FOLD_RECALL_API_KEY=你的密钥
```

不要把密钥写进仓库。

### 3. 检查环境

```sh
node bin/fold-recall.mjs doctor     # Node 版本、billion-context 库、密钥、接口连通
node test/selftest.mjs              # 自测：假数据 + 本地假接口，不需要密钥、不碰真实数据
```

### 4. 挂进宿主

**DSH**（需要 dsh-hoos 插件）：把下面这条加进 `~/.dsh/hooks.json` 的 `hooks["agent/pre-step"]` 数组：

```json
{
  "command": "node \"/path/to/fold-recall/bin/fold-recall.mjs\" hook",
  "commandWindows": "node.exe \"C:/path/to/fold-recall/bin/fold-recall.mjs\" hook",
  "timeout": 12,
  "statusMessage": "fold-recall: 回忆与遗忘",
  "additionalContextLimit": 2500,
  "firstStepOnly": true
}
```

然后在 DSH 的钩子审查弹窗或「设置 → 钩子」里**信任**它。未信任的钩子不会运行。

`agent/pre-step` 在一轮的**每一步**（每次模型调用）之前都会触发。`firstStepOnly: true` 让它每轮只在第一步（带你那条消息的一步）运行，后续步骤不启动进程；需要 dsh-hoos 带这个选项的版本（2026-10-27 起）。旧版本 dsh-hoos 会忽略这个字段，每一步照常触发；那也不影响使用，没有用户消息的步骤 fold-recall 会立即退出（约 0.1 秒）。完整示例见 [examples/dsh-hooks.json](examples/dsh-hooks.json)。

> 如果你之前用过 dsh-compact-timing，请把它那条去掉。fold-recall 已经包含压缩时机判断，两个都留会重复提示。

**Claude Code**（实验性）：只有当 Claude Code 的请求经过 billion-context 代理、会话 id 能对上时，才有记忆可用。写入 `.claude/settings.json`：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node /path/to/fold-recall/bin/fold-recall.mjs hook", "timeout": 12 } ] }
    ]
  }
}
```

### 5.（可选）先整理一遍已有记忆

钩子会在后台自动整理，每次 40 块。已有大量历史的项目，可以先手动跑一遍：

```sh
node bin/fold-recall.mjs consolidate <会话> --limit 500
```

约每 160 块 30 秒。

---

## 使用

装好以后**不需要做任何事**，正常和智能体对话即可。对话里只会在问到旧事时出现一两行：

```
[回忆 · fold-recall] 这条消息涉及较早的工作：
- b91「市场 PR 的最终结果（重要，已收官）」：已折叠，要细节先 decompress b91
```

遗忘在后台执行，压缩时机只记录，都不出现在对话里。它们做了什么，用 `report <会话>` 查看"最近的判断"。

### 命令行

会话可以只写前缀，如 `session-644f9ee0`。

```sh
# 记忆概况：类型分布、钉住的、强度分位、最常被提起的、下次将遗忘的、最近 10 次判断
node bin/fold-recall.mjs report <会话>

# 试运行：这条消息会找回什么、会不会提示压缩/遗忘（不写任何记录，可以随便试）
node bin/fold-recall.mjs recall <会话> "市场 PR 最后合进去没"

# 手动整理
node bin/fold-recall.mjs consolidate <会话> [--limit N]

# 回忆评测：一组带标准答案的问题，逐题试运行（不写记录），统计命中率与误触发
# 题目格式：[{"session":"会话前缀","prompt":"消息","expect":["b91"]}]，expect 为空表示不该触发回忆
node bin/fold-recall.mjs eval <题目.json>

# 遗忘的事后检验：把真实长会话从头重放，对比两种遗忘策略，看被遗忘的块后来有没有又被用到（不调接口、不写记录）
node bin/fold-recall.mjs replay <会话>

# 给压缩时机打标注，用来检验阈值：这一轮之后有没有用到更早的细节
node bin/fold-recall.mjs label <会话> <轮> <none|tail|older|unknown> [备注]

# 修复会话继承（见下文「会话换了 id 后卡住、超窗」）：默认只看计划，加 --apply 执行
node bin/fold-recall.mjs repair <会话> [--apply]

# 检查环境
node bin/fold-recall.mjs doctor
```

`report` 输出示例：

```
同项目会话 73 个，记忆块 160（本会话 97，其中在上下文里 57）
已整理 160：preference 2，knowledge 98，episode 53，noise 7；钉住 15
强度 分位 10/50/90%：0.007 / 0.009 / 0.040；遗忘线 0.026

📌 钉住（永不遗忘）：
  b22   preference key=0.93  方向确认（用户回答）
  b23   knowledge  key=0.95  方向重定：从「复刻 CODEX 格式」改为「DSH 原生钩子 + CODEX 式管理」
  ...
🔥 最常被提起/找回：
  b69   提起 1 找回 1 w=1.518  应用被干趴：SELF_ID 冲突与 v0.5.5
💤 下次将遗忘（本会话）：13 块
```

### 会话换了 id 后卡住、超窗：`repair`

宿主有时会给同一段对话换一个新的会话 id。比如 DSH 重启后恢复会话，界面上看还是同一段对话。这时 billion-context 本应把老会话的折叠状态接过来；但**历史里有图片等非文本内容时，继承会降级**，新 id 只接到一部分摘要块。

剩下的几十万 token 只能靠"请求前现场压缩"，这一步慢、会超时，可能出现：
- 请求卡住几分钟，最后报 `stream idle timeout`；
- 重试时报 `context window exceeds limit`。

2026-10-26 实测的一次：新 id 只接到老会话 57 个块里的 37 个。第一次请求现场压了 5 分钟才压掉 2–3 成，DSH 超时断开；重试时带着 98.7 万 token 发出去，被模型拒绝。

`repair` 不另起炉灶，用的是 billion-context 自己的机制：
- 找到新 id 的父会话（billion-context 记在 `derivedFrom`）。
- 把父会话里**模型当初写好的摘要**，用 billion-context 自己的 `compress` 工具套回新 id 的相同范围。
- 新 id 里已有的块不动；摘要太短的指针块、噪声块不拿来替换大段原文；首尾对齐到新 id 里真实存在的消息编号。
- 不调模型，几秒完成。不划算的范围 billion-context 会自己拒绝，原文仍在库里，可以 `decompress`。

那一次修复用 8 个范围把上下文从约 95 万压到约 58 万，请求恢复正常。

```sh
node bin/fold-recall.mjs repair session-f88b5df8            # 看计划
node bin/fold-recall.mjs repair session-f88b5df8 --apply    # 执行
```

### 数据在哪

| 位置 | 内容 |
|---|---|
| `~/.fold-recall/state.db` | 整理结果（`meta`）、前后关系（`links`）、提起/回忆事件（`events`）、每次判断（`decisions`）、标注（`labels`）、冷却状态 |
| billion-context 的 `index.db` | 记忆块与原文（fold-recall 只读，从不写入） |

想重来，删掉 `~/.fold-recall/state.db` 即可，不影响 billion-context。

---

## 配置

全部通过环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `FOLD_RECALL_API_KEY` / `BAMBOO_API_KEY` | — | 决策接口密钥 |
| `FOLD_RECALL_ENDPOINT` | `https://api.bamboonode.dev/v1/decisions`（StartLux） | 任何同形接口都可以：请求 `{model, state, questions}`，返回 `{answers: {题号: {probabilities: {选项: 概率}}}}` |
| `FOLD_RECALL_MODEL` | `startlux-decision-27b-autothink` | |
| `FOLD_RECALL_TIMEOUT_MS` | `6000` | 钩子里等决策的上限，超时什么也不注入 |
| `FOLD_RECALL_FORGET` | `auto` | 遗忘：`auto` 后台直接折成索引 · `hint` 注入提示让模型做 · `off` 只记录 |
| `FOLD_RECALL_TIMING` | `off` | 压缩时机：`off` 只记录 · `hint` 注入提示 |
| `BILI_PROXY` | `http://127.0.0.1:18787` | billion-context 代理地址（后台遗忘、`repair` 经它的插件接口写入） |
| `FOLD_RECALL_HOME` | `~/.fold-recall` | 状态库与 `.env` 的位置 |
| `BILI_INDEX_DB` | `~/.local/share/billion-context/sessions/index.db` | billion-context 的库 |
| `FOLD_RECALL_DEBUG` | — | 设为 1 时，钩子把异常打到 stderr |

阈值（强度、钉住线、遗忘线、冷却）在 `lib/memory.mjs` 和 `lib/engine.mjs` 顶部，都有注释。

---

## 会发给决策接口的内容

- **整理**：每个记忆块的主题与摘要（≤1800 字），以及最多 24 个更早块的主题。
- **每条消息**：
  - 新消息（≤300 字）；
  - 最近 3 轮的请求摘要和用到的工具名；
  - 上一轮回复的结尾（≤400 字）；
  - 候选记忆的主题与摘要开头（每个 ≤70 字）。
- 发出前一律脱敏：`sk-…` 开头的密钥和 ≥32 位的随机串替换为 `<已脱敏>`。

**脱敏不能覆盖所有格式**（如短密码、Cookie 片段）。如果你的会话里经常出现这类内容，请评估后再用，或换成自己部署的决策接口。

---

## 实测结果

2026-10-26 至 10-27，在两个真实 DSH 会话上（一个约 9700 条消息、一个约 2700 条，同项目共 283 个记忆块）。**样本小，阈值是看着这些例子定的，还没有独立验证。**

### 整理

- 283 块全部判完，每 160 块约 27 秒，无失败。
- 类型分布：知识约 60%，过程约 35%，噪声约 4%，偏好/约定约 1–2%。
- 钉住的是：用户的任务契约、方向性决定（如"从复刻 CODEX 改为 DSH 原生"）、架构结论。

### 回忆（`eval`）

38 条带标准答案的题：27 条"问旧事"（hooks 插件、市场 PR、折叠插件、记忆插件、huashu-chrome 项目），11 条不该触发回忆的普通消息（"继续""提交一下"、新任务、常识问题）。

| | 结果 |
|---|---|
| 问旧事：找回了正确的块 | **27/27** |
| 正确答案进了候选 | 27/27 |
| 普通消息误触发 | **0/11** |
| StartLux 对正确答案的把握 | 多数 ≥ 0.9 |
| 决策延迟（中位） | 1.3 秒 |

**注意**：题目是对着记忆块主题写的，用词接近，比真实使用简单。用自己的说法问时准确率多半会低一些，还没测（见[测试指南](#测试指南)第 4 步）。

调参中修掉的问题：

- 只用字面相关度时，"最后合进去没"找不到写着"最终结果"的那段 → 加了"相关块的下一段"和"最近最牢"两类候选。
- 记忆库里没出现过的虚词（"当时""怎么"）把相关度拉低 → 这类词不计分。
- 复制/恢复出的会话继承了同样的块，候选里同一内容出现两份，把概率摊薄（把握只有 0.4 左右）→ 候选按内容去重。
- 只含一个名字的问题（"cmux 是个啥来着"）不触发 → 一个少见的英文/标识符就够。

### 遗忘（`replay`）

把约 9700 条消息的长会话从头重放（3884 条可用消息、97 个块），按真实规则模拟后台遗忘，再看被遗忘的块之后有没有又被提到（按特征词：PR 号、文件名、专有名词）。

- **基线**：所有块折叠之后，有 1/3（32/97）又被提到过——检测器是灵的。

| | 保守（默认：只忘过程/噪声） | 放开（知识也会忘） |
|---|---|---|
| 遗忘 | 13 块 | 35 块（多 22 个知识块） |
| 移出上下文的摘要 | 约 1.7 万字 | 约 4.8 万字 |
| 之后又被提到 | 1 块（"系统提示快照"，误报） | 2 块（多出一个知识块，遗忘后隔 439 条又被提到） |

结论：强度算法挑得准（普通块 1/3 会被再提到，被挑去遗忘的几乎不会）；保守策略安全但省得少；放开多省约 3 万字，代价是可能忘错知识，而模型自己默默需要时察觉不到。目前默认保守。

局限：只有一个会话有效（另一个会话库里只存了 22 条用户消息，检测不出东西）；"又被提到"按特征词估，隐性需要测不到；重放没有模拟"找回"（真实情况遗忘会更少）。

### 真实对话（DSH 钩子，前 4 条消息）

| 你说的 | 判断 | |
|---|---|---|
| 跑下看看（重发） | 不是新任务 | ✅ |
| 贴了一篇 PDF 工具的文章 | 换话题（0.98）→ 提示压缩；模型照做，把上一件折成了一块 | ✅ |
| 暂时不安装 hybrid 有需要再说 | 8 个候选，判断不需要旧记忆 | ✅ |

回忆和后台遗忘还没在真实对话里触发过。

---

## 测试指南

在另一台机器上从头验证一遍，按顺序做。每一步都**不改** billion-context 的数据，除非特别说明。

**0. 前提**：这台机器上的智能体已经通过 billion-context 跑过一段时间（有折叠出来的记忆块）；Node ≥ 22.5；有 StartLux 密钥。

**1. 环境与自测**

```sh
git clone https://github.com/matata2017/fold-recall.git && cd fold-recall
node bin/fold-recall.mjs doctor        # Node、billion-context 库、密钥、接口都应 OK
node test/selftest.mjs                 # 应全部通过（不需要密钥，不碰真实数据）
```

**2. 找一个长会话**

```sh
node bin/fold-recall.mjs report <会话前缀>
```

会话 id 在 billion-context 的网页 `http://127.0.0.1:18787/__bili/` 或 DSH 的会话目录里能看到。挑消息最多、跑得最久的那个。第一次看到"已整理 0"是正常的，先跑一遍整理（会调 StartLux，约每 160 块 30 秒）：

```sh
node bin/fold-recall.mjs consolidate <会话前缀> --limit 500
node bin/fold-recall.mjs report <会话前缀>     # 看类型分布、钉住的是不是真重要的
```

**看什么**：钉住的块是不是你真心觉得"必须记住"的；"下次将遗忘"里有没有你觉得不该忘的。

**3. 遗忘的事后检验**

```sh
node bin/fold-recall.mjs replay <会话前缀>
```

**看什么**：基线比例（太低说明这个会话测不出东西，换一个）；两种策略各遗忘多少、"之后又被提到"的有哪些——逐条看是不是真的需要那段旧内容。

**4. 回忆评测（最重要的一步：用你自己的话出题）**

新建一个 JSON 文件，比如 `my-eval.json`：

```json
[
  { "session": "会话前缀", "prompt": "那次我说你抢跑了是咋回事", "expect": ["b6"] },
  { "session": "会话前缀", "prompt": "继续", "expect": [] }
]
```

- `expect` 填正确答案所在的块号（从 `report` 或 billion-context 网页里查）；可以填多个，命中任意一个算对；**留空表示这条不该触发回忆**。
- 出题要点：**用你平时真会说的话**，故意避开块主题里的关键词（换说法、只说半句、用"那次""之前那个"指代）；问旧事的和普通消息大约一半一半。

```sh
node bin/fold-recall.mjs eval my-eval.json
```

**看什么**：问旧事的"找回正确"比例、"正确答案进了候选"比例（这个低说明字面匹配不够，需要语义检索）、普通消息的误触发。

**5. 真实使用**

挂上钩子正常用几天，然后：

```sh
node bin/fold-recall.mjs report <会话前缀>     # 末尾"最近的判断"：每条消息找回了什么、后台遗忘了什么
```

遇到下面的情况记一笔（`label` 命令，或直接记下来加进第 4 步的题目）：模型问了你已经说过的事、重做了已经做完的排查、和之前的决定矛盾、找回的内容明显不相关。

```sh
node bin/fold-recall.mjs label <会话前缀> <轮次> older "它忘了之前定的 xxx"
```

---

## 路线图

### 保留还是移除：按数据决定

| 功能 | 现状 | 保留的条件 | 不达标怎么办 |
|---|---|---|---|
| **回忆** | 自测 27/27、误触发 0/11；真实对话还没触发过 | 用自己的话出题，命中 ≥ 70%、误触发 ≤ 10% | 命中低但"进了候选"高 → 调提示/阈值；进候选都低 → 加语义检索 |
| **整理（类型/重要性）** | 稳定；钉住的基本是真重要的 | 钉住的你认可 | 调钉住线 |
| **后台遗忘（保守）** | 安全，但一次只省几千 token | 多个会话重放都没忘错，且省得有意义 | 省得太少就关掉（`FOLD_RECALL_FORGET=off`），交给 billion-context 自己的分层蒸馏 |
| **压缩时机** | 判断准；默认只记录 | 真实对话里提示被模型采纳、没误报 | 已经只记录，不影响对话 |
| **继承修复（`repair`）** | 救过一次超窗的会话 | 留着，零成本 | — |

**我的倾向**：回忆和整理是核心，保留；后台遗忘先保守地开着，攒数据，如果几周后看下来省得太少，就关掉，把"淡忘"这件事完全交给 billion-context，fold-recall 只负责"重要的不忘"和"问起时想起"。

### 接下来的优化（按优先级）

1. **你自己的题目集**（测试指南第 4 步）：决定回忆要不要加语义检索。
2. **更多会话重放**：至少再找两三个长会话跑 `replay`，决定知识类能不能放开遗忘。
3. **压缩时机改成一行提示**：数据显示提示被模型采纳过；一行（"这是新任务：先 compress 上一件，保留未完成事项"）既有用又不打扰。
4. **和 dsh-mnemon 分工**：mnemon 已覆盖偏好与项目知识（跨会话），fold-recall 回忆时可以少注入这两类，只补过程细节，避免重复。
5. **自动修复继承**：检测到会话换了 id 而且继承没接全，自动跑 `repair`，不用等出事再手动。
6. **语义检索（视第 1 步结果）**：只在字面匹配明显不够时再加，尽量不引入依赖（可以复用 billion-context 或 mnemon 已有的检索能力）。
7. **DSH 插件面板（可选）**：把 `report` 的内容做成 DSH 里的面板，像 hooks 插件的统计弹窗那样。
8. **反馈给 billion-context**：会话继承遇到图片会降级的问题（日志里有完整证据），提 issue。

---

## 局限与常见问题

**相关度是字面的。** 换个说法可能找不到候选。"最近最牢"的候选能补一部分。没有用向量库，是为了零依赖、零部署。

**遗忘和压缩只是提示。** 模型可以不照做。是否执行可以在 billion-context 的块记录里看到。

**依赖 billion-context 的表结构。** 它升级改表时，可能需要跟着改 `lib/bili.mjs`。读取全是只读的。

**它会拖慢对话吗？** 每条用户消息多一次 1–3 秒的决策请求，上限 6 秒。整理在后台，不挡对话。

**没有 billion-context 能用吗？** 不能。记忆块、原文和展开工具都来自它。

**换别的决策模型？** 改 `FOLD_RECALL_ENDPOINT` / `FOLD_RECALL_MODEL`，接口形状一致即可。题目都在 `lib/decide.mjs`。

---

## 致谢

- **billion-context**：上下文折叠、记忆块与原文存储。
- **compact-adviser**：压缩时机的原子题与评分规则（逐字沿用）。
- **Jev-Mem**：用小型决策模型做记忆的类型判断、关系判断与路由的思路。
- **ACT-R、MemoryBank、Generative Agents**：强度随时间衰减、被回忆即强化、按重要性加权。

## License

[MIT](LICENSE)

---

## English

**fold-recall** gives long-running agents (assistants and coding sessions that never start over) human-like long-term memory on top of billion-context's folded blocks. A small decision model does the judging: StartLux by default, or any compatible endpoint.

**What it aims for:** the context stays lean, while things from thousands of messages ago can still be answered when someone asks.

**How it works**

- **Strength.** Each block has an ACT-R strength `Σ c·(age+1)^-0.5`, with age counted in messages elapsed. Creation counts c=1, every mention c=0.5, every recall c=1. Frequently discussed things stay strong; neglected ones fade.
- **Consolidation.** A background pass asks the decision model for each block's type (preference / knowledge / episode / noise), its importance, and which earlier block it continues.
- **Pinning.** Preferences, and blocks with P(key) ≥ 0.8, are never forgotten. Everything else fades more slowly the more important it is: `retention = strength × (1 + P(key))`.
- **Forgetting.** In-context blocks whose retention falls below about 1500 messages of disuse are folded in the background, through billion-context's own `compress`, into a topic-only index block (the old blocks nest inside it). Nothing appears in the chat; originals stay in the database.
- **Recall.** Each user message gets up to 24 candidates: lexical matches, the block after each match, and recent strong memories. The decision model picks what to bring back and where the latest progress is. Folded blocks in the current session get a `decompress` hint; forgotten or cross-session blocks have their summary injected.
- **Compaction timing.** Topic switches are judged and logged; billion-context already nudges compaction, so nothing is injected unless `FOLD_RECALL_TIMING=hint`.

**Guarantees**

- At most one decision request per user message (1–3 s; 6 s cap).
- Nothing is injected on any failure.
- billion-context is read-only to it.
- No npm dependencies (Node ≥ 22.5).

**Install**

1. `git clone`.
2. Set `FOLD_RECALL_API_KEY`.
3. Run `node bin/fold-recall.mjs doctor`.
4. Add the hook to DSH `agent/pre-step` (see `examples/dsh-hooks.json`) or, experimentally, to Claude Code `UserPromptSubmit`.

Run `node test/selftest.mjs` for an offline self-test. Use `report <session>` and `recall <session> "<message>"` to inspect and dry-run.
