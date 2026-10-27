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
| **遗忘** | 保持度掉到遗忘线以下的块，提示模型用 `compress` 把它们合并成一行索引，拿出上下文 | 每条消息检查，有冷却 |
| **回忆** | 新消息涉及某段旧事时，找回那一段，以及这件事**最新进展**的那一段，放回上下文 | 每条用户消息 |
| **压缩时机** | 明确换话题，或上一件做完又开始新任务时，提示先压缩上一件的历史 | 每条用户消息，有冷却 |
| **试运行与报告** | 命令行查看记忆概况，或试一条消息"会找回什么" | 手动 |
| **继承修复** | 会话换了 id、折叠状态没接全时，把老会话已有的摘要套回来 | 手动（`repair`） |

所有提示都只是**往对话里加一段说明**，不会替模型做操作。任何一步失败或超时，**什么也不注入**。宁可不提示，也不乱提示。

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

满足以下全部条件的块，会出现在 `[遗忘]` 提示里：

- 属于**当前会话**，且仍在上下文中；
- 已整理、未钉住；
- **保持度 < 遗忘线**。遗忘线 = `1500^-0.5`，约等于"之后 1500 条消息都没用到"。

遗忘只按**本会话**经过的消息算：恢复一个旧会话时，它眼前的内容不会因为别的会话做了很多事而被挤掉。

提示会按原文位置把连续的块合成段，请模型调用 `compress` 把每段压成一行索引。每次最多 12 块，至少 3 块才提示，两次提示间隔 ≥ 300 条消息。**原文仍完整保存在 billion-context 库里**，之后被问到时由回忆找回。

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
   - 本会话里仍在折叠中的块 → 提示模型 `decompress bN` 展开原文；
   - 已被合并/遗忘的块、其他会话的块 → 直接注入它的摘要（≤900 字）。
6. 被找回的块记一次"回忆"，强度大幅提升，短期内不会再被遗忘。

### 压缩时机

沿用 compact-adviser 的两道原子题（逐字），再加一道"新请求与之前工作的关系"：

- `pNew` = 1 − P(继续同一项工作)；`S1` = P(完成) × (0.5 + 0.5 × P(动手做))；`S2` = S1 × pNew
- **换话题**：pNew ≥ 0.85 → 提示压缩。摘要要保留未完成事项，用户之后可能切回来。
- **做完换新**：S2 ≥ 0.5 → 提示压缩。
- 闸门：本会话第 3 轮起、上下文 ≥ 4 万 token、距上次提示 ≥ 3 轮。

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
  "additionalContextLimit": 2500
}
```

然后在 DSH 的钩子审查弹窗或「设置 → 钩子」里**信任**它。未信任的钩子不会运行。完整示例见 [examples/dsh-hooks.json](examples/dsh-hooks.json)。

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

装好以后**不需要做任何事**，正常和智能体对话即可。你会在对话里看到这几类说明（模型能看到，你也能在钩子记录里看到）：

```
[回忆 · fold-recall] 这个请求涉及较早的工作「市场 PR 的最终结果」（b91，已折叠）。需要细节时，先调用 decompress 展开 b91。

[回忆 · fold-recall] 「Mnemon→Hindsight provider 接线收尾与端到端」（2026-10-21，本会话的 b65；原文仍在 billion-context 库中）：
……摘要……

[压缩时机 · fold-recall] 用户的新请求是一项和之前工作不同的新任务（把握 99%，当前上下文已用 30%）……请先调用 compress……

[遗忘 · fold-recall] 下面这些旧摘要块很久没用到了……请调用 compress 把每一段合并成一个简短的索引块……
- m00001–m00410：b1「监工 session…」、b3「市场判定…」……
```

### 命令行

会话可以只写前缀，如 `session-644f9ee0`。

```sh
# 记忆概况：类型分布、钉住的、强度分位、最常被提起的、下次将遗忘的、最近 10 次判断
node bin/fold-recall.mjs report <会话>

# 试运行：这条消息会找回什么、会不会提示压缩/遗忘（不写任何记录，可以随便试）
node bin/fold-recall.mjs recall <会话> "市场 PR 最后合进去没"

# 手动整理
node bin/fold-recall.mjs consolidate <会话> [--limit N]

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
💤 下次将提示遗忘（本会话）：31 块
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

2026-10-26，在两个真实 DSH 会话上（一个约 9700 条消息、一个约 2700 条，同项目共 283 个记忆块）。**样本小，阈值是看着这些例子定的，还没有独立验证。**

**整理**

- 283 块全部判完，每 160 块约 27 秒，无失败。
- 类型分布：知识约 60%，过程约 35%，噪声约 4%，偏好/约定约 1–2%。
- 钉住的是：用户的任务契约、方向性决定（如"从复刻 CODEX 改为 DSH 原生"）、架构结论。

**遗忘**

- 约 9700 条消息的长会话：在上下文里的 57 块中，31 块会被提示遗忘，分几次提示。
- 刚恢复的旧会话：只遗忘 3 个早期块。

**回忆**（手写的 7 条消息）

| 消息 | 结果 |
|---|---|
| 市场 PR 最后合进去没 | ✅ 找回「市场 PR 的最终结果」，p = 0.88 |
| 那个 SELF_ID 冲突当时是怎么修的 | ✅ 找回「SELF_ID 冲突与 v0.5.5」，p = 0.97 |
| hindsight 当时是怎么接到 mnemon 上的 最后通了没 | ✅ 找回「接线收尾与端到端」（相似段有约 30 个，靠"都不需要"概率 0.02 接受） |
| 进件中心按姓名查询那个任务 怎么验收的 | ✅ 找回「任务二已完成并独立验收」，p = 0.97 |
| hooks 插件的审查弹窗 最早是怎么定的方向 | ⚠️ 找回「方向定稿」，相关但不是最早那段「方向重定」 |
| 好的 你继续 | ✅ 不触发回忆 |
| 帮我写个 python 爬虫抓一下天气预报 | ✅ 不触发回忆；提示换话题压缩 |

调参过程中遇到并修掉的问题，也许对你有参考价值：

- 只用字面相关度时，"最后合进去没"找不到写着"最终结果"的那段 → 加了"相关块的下一段"和"最近最牢"两类候选。
- 记忆库里没出现过的虚词（"当时""怎么"）把相关度拉低 → 这类词不计分。
- 跨会话计龄时，恢复旧会话会把眼前的内容大量判为遗忘 → 遗忘改为只按本会话计龄。

每次判断都记在 `decisions` 表里。欢迎拿自己的会话跑 `recall` 试运行，反馈误判。

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
- **Forgetting.** In-context blocks whose retention falls below about 1500 messages of disuse are suggested for `compress` into a one-line index. Originals stay in the database.
- **Recall.** Each user message gets up to 24 candidates: lexical matches, the block after each match, and recent strong memories. The decision model picks what to bring back and where the latest progress is. Folded blocks in the current session get a `decompress` hint; forgotten or cross-session blocks have their summary injected.
- **Compaction timing.** On a clear topic switch, it hints `compress`.

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
