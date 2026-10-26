# fold-recall

**给"一直跑、不开新会话"的智能体加上像人一样的长期记忆。**
建立在 [billion-context](https://github.com/) 的上下文折叠之上，用一个小型决策模型（默认 StartLux）判断：这件事重不重要、现在该想起哪段旧事、哪些旧事可以先忘掉。

> English summary at the bottom.

## 它解决什么问题

长时间运行的智能体（个人助理、监工、一直不关的编程会话）会遇到三件事：

1. **旧东西一直占着上下文**。billion-context 会把历史折叠成摘要块，但摘要块本身越积越多——一个跑了 9700 条消息的真实会话里，上下文中仍挂着 57 个摘要块，其中大半是早已结束的工作。
2. **该想起的想不起来**。折叠后的原文都还在库里，但模型几乎从不主动调用 `decompress` / `search_context` 去找（我们看过的会话里一次都没有）。
3. **重要的和琐碎的一样对待**。用户定下的约定、方向性的决定，和一次性的排查过程，被同样地折叠、同样地淡忘。

## 它怎么做（像人一样记）

| 人的记忆 | fold-recall |
|---|---|
| 越久没想起越淡 | 每块记忆有强度 `w = Σ c·(经过的消息数+1)^-0.5`（ACT-R 基础激活）。按"之后又做了多少事"计，闲置几天不会变淡 |
| 常被提起的记得牢 | 用户消息提到某段旧事（字面相关）→ 记一次"提起"（c=0.5）；被找回 → 记一次"回忆"（c=1）。最近一直提的越来越牢，慢慢不提了就慢慢变淡 |
| 重要的不会忘 | 后台整理时让决策模型给每块判**类型**（偏好/约定、知识、过程、噪声）和**重要性**。偏好/约定，或重要性 P(key) ≥ 0.8 → **钉住，永不遗忘**；其余的，越重要忘得越慢（保持度 = 强度 × (1 + P(key))） |
| 忘了的不在眼前，问起来才想起 | 保持度低于遗忘线（≈1500 条消息没用到）的块，提示模型把它们 `compress` 成一行索引，**拿出上下文**。原文仍在库里 |
| 被问起时去回想 | 每条新消息：字面相关 + 最近最牢 + 相关段的下一段 → 最多 24 个候选，决策模型选"需要找回哪段"以及"这件事最新的进展在哪段"。本会话折叠中的块 → 提示 `decompress`；已遗忘/其他会话的块 → 直接注入摘要 |

另外保留了 [dsh-compact-timing](../dsh-compact-timing) 的**压缩时机**判断：明确换话题（新任务概率 ≥ 0.85）或上一件做完且是新任务（得分 ≥ 0.5）时，提示模型先把上一件工作折叠成摘要（必须保留用户的要求与约定、未完成事项）。

**一次用户消息最多一次决策请求**（回忆题 + 时机题合在一起），实测 1–3 秒；整理在后台进程里做，不挡对话。任何一步失败或超时（默认 6 秒），都**什么也不注入**——宁可不提示，不乱提示。

```
用户消息 ──► 钩子 ──► 读 billion-context 库（只读） ──► 算强度、相关度
                         │
                         ├─► 记"提起"
                         ├─► 一次决策请求：找回哪段？最新进展在哪段？是不是换话题了？
                         ├─► 遗忘候选（不需要问模型）
                         └─► 注入：[回忆] / [压缩时机] / [遗忘]
                    后台：整理新出现的记忆块（类型、重要性、前后关系）
```

## 安装

需要 **Node ≥ 22.5**（内置 `node:sqlite`），以及正在运行的 **billion-context**（它的库在 `~/.local/share/billion-context/sessions/index.db`）。零依赖，不需要 `npm install`。

**密钥**：`FOLD_RECALL_API_KEY`（或 `BAMBOO_API_KEY`）放进环境变量，或写入 `~/.fold-recall/.env`：

```
FOLD_RECALL_API_KEY=你的密钥
```

```sh
node bin/fold-recall.mjs doctor          # 检查 Node、billion-context 库、密钥、接口
node test/selftest.mjs                   # 自测（假数据 + 本地假接口，不需要密钥）
```

### DSH

把下面这条加进 `~/.dsh/hooks.json` 的 `agent/pre-step`（需要 dsh-hoos 插件），然后在 DSH 的钩子审查里**信任**它：

```json
{
  "command": "node \"/path/to/fold-recall/bin/fold-recall.mjs\" hook",
  "commandWindows": "node.exe \"C:/path/to/fold-recall/bin/fold-recall.mjs\" hook",
  "timeout": 12,
  "statusMessage": "fold-recall: 回忆与遗忘",
  "additionalContextLimit": 2500
}
```

### Claude Code（实验性）

只有当 Claude Code 的请求经过 billion-context 代理、会话 id 能对上时才有记忆可用。`.claude/settings.json`：

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "node /path/to/fold-recall/bin/fold-recall.mjs hook", "timeout": 12 } ] } ] } }
```

## 命令行

```sh
fold-recall report <会话>                  # 记忆概况：类型分布、钉住的、强度分位、将被遗忘的、最近的判断
fold-recall recall <会话> "<消息>"         # 试运行：这条消息会找回什么、会不会提示压缩/遗忘（不写任何记录）
fold-recall consolidate <会话> [--limit N] # 手动整理（钩子会在后台自动跑）
fold-recall label <会话> <轮> <none|tail|older|unknown> [备注]   # 给压缩时机打标注
```

会话可以只写前缀，如 `session-644f9ee0`。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `FOLD_RECALL_API_KEY` / `BAMBOO_API_KEY` | — | 决策接口密钥 |
| `FOLD_RECALL_ENDPOINT` | StartLux `https://api.bamboonode.dev/v1/decisions` | 任何同形接口（`{model, state, questions}` → `{answers: {id: {probabilities}}}`）都可替换 |
| `FOLD_RECALL_MODEL` | `startlux-decision-27b-autothink` | |
| `FOLD_RECALL_TIMEOUT_MS` | 6000 | 钩子里等决策的上限，超时什么也不注入 |
| `FOLD_RECALL_HOME` | `~/.fold-recall` | 自己的状态库 `state.db`（整理结果、提起/回忆事件、判断记录） |
| `BILI_INDEX_DB` | `~/.local/share/billion-context/sessions/index.db` | billion-context 的库（**只读**） |

## 会发给决策接口的内容

- **整理**：每个记忆块的主题与摘要（≤1800 字），以及最多 24 个更早块的主题。
- **每条消息**：新消息（≤300 字）、最近 3 轮的请求摘要与工具名、上一轮回复结尾（≤400 字）、候选记忆的主题与摘要开头（每个 ≤70 字）。
- 发出前一律脱敏：`sk-…` 和 ≥32 位的随机串替换为 `<已脱敏>`。**这不能覆盖所有密钥格式**——如果你的会话里经常出现密码、Cookie 等，请自行评估。

## 实测（2026-10-26，两个真实 DSH 会话，样本小，仅供参考）

- 整理：283 个记忆块，每 160 块约 27 秒（并发 4），无失败。类型分布：知识 60%、过程 35%、偏好/约定 1–2%、噪声 4%。
- 重要性：决策模型认为大部分工作都"重要"（P(key) 中位数 0.55），所以钉住线定在 0.8（约 10%）；钉住的是用户的任务契约、方向性决定、架构结论。
- 遗忘：跑了 9700 条消息的会话，57 个在上下文里的块中 31 个会被提示遗忘（一次提示最多 12 个）；刚恢复的旧会话只遗忘 3 个早期块（遗忘只按本会话经过的工作量算）。
- 回忆：7 条手写问题里 6 条找回了正确的块（如"市场 PR 最后合进去没"→「市场 PR 的最终结果」p=0.88；"SELF_ID 冲突当时怎么修的"→ p=0.97），"好的 你继续""写个爬虫抓天气"不触发回忆。

**这些阈值是看着这几十个例子定的，还没有独立验证。** `decisions` 表记录了每次判断，欢迎拿自己的会话跑 `recall` 试运行、反馈误判。

## 局限

- 相关度是字面的（中文二字组 + 英文词，按逆文档频率加权，主题加倍），换个说法可能找不到；"最近最牢"的候选部分弥补。
- 遗忘靠模型执行 `compress`：只是提示，模型可以不照做。
- 只读 billion-context 的库，不写；它的表结构变化时可能需要跟着改 `lib/bili.mjs`。

## 致谢

- [compact-adviser](https://github.com/)：压缩时机的原子题与评分规则（逐字沿用）。
- Jev-Mem：用小型决策模型做记忆的类型判断、关系判断与路由的思路。
- ACT-R、MemoryBank、Generative Agents：强度随时间衰减、被回忆即强化、重要性加权。

## License

MIT

---

## English

**fold-recall** adds human-like long-term memory to agents that run for a long time without starting a new session. It sits on top of billion-context's folded blocks and uses a small decision model (StartLux by default, any compatible endpoint works) to:

- **weigh** each memory with an ACT-R style strength `Σ c·(age+1)^-0.5`, where age is messages elapsed and every mention (c=0.5) or recall (c=1) reinforces it;
- **pin** what matters: a background pass classifies each block (preference / knowledge / episode / noise) and its importance; preferences and P(key) ≥ 0.8 are never forgotten, the rest fade more slowly the more important they are;
- **forget**: blocks still in context whose retention falls below ~1500 messages of disuse are suggested for `compress` into a one-line index. The originals stay in the database;
- **recall**: for every user message, up to 24 candidates (lexical matches, recent strong memories, and the block after each match) go to the decision model, which picks what to bring back and where the latest progress is. Folded blocks in the current session get a `decompress` hint; forgotten or cross-session blocks have their summary injected;
- **time compaction**: hint `compress` on clear topic switches.

There is at most one decision request per user message (1–3 s). On any failure or timeout nothing is injected. It has zero dependencies (Node ≥ 22.5), reads billion-context read-only, and works as a DSH `agent/pre-step` hook or (experimentally) a Claude Code `UserPromptSubmit` hook. Run `node test/selftest.mjs` for an offline self-test.
