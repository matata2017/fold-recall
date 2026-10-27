/**
 * replay.mjs — 遗忘的事后检验：把一个真实长会话从头重放，看"按某个策略会被遗忘的块"后来有没有又被用到。
 *
 * 不调用任何接口、不写任何东西：
 * - 每条用户消息处，按当时的消息编号算各块强度（本会话时钟），"提起"按当时之前的真实用户消息模拟；
 *   找回（recall）事件不模拟（要调决策模型），所以遗忘会比真实情况略激进。
 * - 遗忘按真实规则：冷却 300 条、一次最多 12 块、至少 3 块；块在折叠出来之前不算存在（结束编号 + 300 之后才可用）。
 * - "又被用到"：之后的用户消息或模型回复（不含 compress/decompress 等工具调用、宿主注入）里，
 *   出现了这块的若干个"特征词"（在全会话的块里少见的词：PR 号、函数名、专有名词）。
 */
import { INJECTED } from './bili.mjs'
import { FORGET_W, FORGETTABLE, PIN_KEY, MENTION_C, grams, indexBlocks, relevance } from './memory.mjs'

const json = (s) => { try { return JSON.parse(s ?? 'null') ?? {} } catch { return {} } }
const SKIP_TOOLS = /^(compress|decompress|search_context|acp_status|acp_)/

/** 会话的消息（按顺序）：{ ref, role, kind, text, user: 是不是用户真正说的话 } */
export function loadMessages(bdb, sessionId) {
  const rows = bdb.prepare(`select m.ref_num ref, m.role, m.kind, c.bytes from messages m join content c on c.hash = m.content_hash
                            where m.session_id = ? order by m.seq`).all(sessionId)
  const out = []
  for (const r of rows) {
    const msg = json(Buffer.from(r.bytes).toString('utf8'))
    const text = String(msg.text ?? '')
    if (r.kind === 'tool-call' && SKIP_TOOLS.test(String(msg.toolName ?? ''))) continue
    if (r.kind === 'tool-result' || r.kind === 'reasoning') continue           // 工具输出与思考不算"用到"
    const user = r.role === 'user' && r.kind === 'text' && !INJECTED.test(text.trim())
    if (r.role === 'user' && !user) continue
    out.push({ ref: Number(r.ref) || 0, role: r.role, kind: r.kind, text, user })
  }
  return out
}

/** 每块的特征词：在本会话所有块里最多出现在 2 块中的词，取主题与摘要开头里的前 20 个 */
function signatures(blocks) {
  const df = new Map()
  for (const b of blocks) for (const g of grams(b.topic + ' ' + b.summary)) df.set(g, (df.get(g) ?? 0) + 1)
  const sig = new Map()
  for (const b of blocks) {
    const gs = [...grams(b.topic + ' ' + b.summary.slice(0, 600))].filter((g) => (df.get(g) ?? 0) <= 2 && g.length >= 2)
    // 英文/编号类优先（更像名字），其次中文二字组
    gs.sort((x, y) => Number(/^[a-z0-9_.-]+$/.test(y)) - Number(/^[a-z0-9_.-]+$/.test(x)))
    sig.set(b.key, new Set(gs.slice(0, 20)))
  }
  return sig
}

/**
 * 重放一个策略。policy(b) 决定某块是否允许遗忘（在"未钉住、保持度 < 遗忘线"之外再加的条件）。
 * 返回 { forgotten: [{ block, at, reusedAt, reusedBy }], passes }
 */
export function replay(mem, meta, messages, sessionId, policy, { cooldown = 300, maxBlocks = 12, minBlocks = 3, lag = 300, minOverlap = 3 } = {}) {
  const blocks = mem.blocks.filter((b) => b.session_id === sessionId && b.end_ref != null)
    .map((b) => ({ ...b, type: meta.get(b.key)?.type ?? null, pKey: meta.get(b.key)?.p_key ?? 0, a: Number(b.start_ref), z: Number(b.end_ref) }))
    .sort((x, y) => x.a - y.a)
  for (const b of blocks) b.pinned = b.type === 'preference' || b.pKey >= PIN_KEY
  const sig = signatures(blocks)
  const mentions = new Map()                                                    // key → [ref]
  const forgotten = new Map()                                                   // key → { block, at }
  let lastPass = -Infinity, passes = 0

  const users = messages.filter((m) => m.user)
  for (const m of users) {
    const t = m.ref
    const avail = blocks.filter((b) => b.z + lag <= t)
    if (!avail.length) continue
    // 提起：和线上同一套规则（相关度 ≥ 0.28、命中 ≥ 2 个词、取前 3）
    const idf = indexBlocks(avail)
    const q = grams(m.text)
    const scored = avail.map((b) => ({ b, r: relevance(q, b, idf), h: b.hits })).filter((x) => x.r >= 0.28 && x.h >= 2)
      .sort((x, y) => y.r - x.r).slice(0, 3)
    for (const { b } of scored) (mentions.get(b.key) ?? mentions.set(b.key, []).get(b.key)).push(t)
    // 遗忘
    if (t - lastPass < cooldown) continue
    const keep = (b) => {
      let w = (Math.max(0, t - b.z) + 1) ** -0.5
      for (const r of mentions.get(b.key) ?? []) w += MENTION_C * (Math.max(0, t - r) + 1) ** -0.5
      return w * (1 + b.pKey) * (b.type === 'noise' ? 0.5 : 1)
    }
    const fresh = new Set(scored.map((x) => x.b.key))
    const cand = avail.filter((b) => !forgotten.has(b.key) && !fresh.has(b.key) && b.type && !b.pinned && policy(b) && keep(b) < FORGET_W)
    if (cand.length < minBlocks) continue
    for (const b of cand.slice(0, maxBlocks)) forgotten.set(b.key, { block: b, at: t })
    lastPass = t
    passes++
  }

  // 遗忘之后有没有又被用到
  const result = []
  for (const { block, at } of forgotten.values()) result.push({ block, at, ...reusedAfter(messages, sig.get(block.key), at, minOverlap) })
  // 基线：所有块在折叠出来之后（结束编号 + lag）有没有又被提到——检测器灵不灵，看这个比例
  const baseline = blocks.filter((x) => x.type).map((x) => ({ block: x, ...reusedAfter(messages, sig.get(x.key), x.z + lag, minOverlap) }))
  return { forgotten: result.sort((x, y) => x.at - y.at || x.block.a - y.block.a), passes, total: blocks.length, baseline }
}

/** 某时刻之后第一条"用到"这块的消息：出现了它至少 30%（且 ≥ minOverlap 个）的特征词 */
function reusedAfter(messages, sig, at, minOverlap) {
  if (!sig || sig.size < minOverlap) return { reusedAt: null, reusedBy: null }
  const need = Math.max(minOverlap, Math.ceil(sig.size * 0.3))
  for (const m of messages) {
    if (m.ref <= at) continue
    const g = grams(m.text)
    let n = 0
    for (const x of sig) if (g.has(x)) n++
    if (n >= need) return { reusedAt: m.ref, reusedBy: m.user ? 'user' : m.role }
  }
  return { reusedAt: null, reusedBy: null }
}

export const POLICIES = {
  conservative: { label: '保守（只忘过程/噪声）', fn: (b) => FORGETTABLE.has(b.type) },
  all: { label: '原来（知识也会忘）', fn: (b) => b.type !== 'preference' },
}
