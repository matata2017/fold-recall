// bili.mjs — 只读访问 billion-context 的存储（index.db）：记忆块、会话时钟、上下文用量、最近几轮对话
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BILI_DB = process.env.BILI_INDEX_DB || join(homedir(), '.local', 'share', 'billion-context', 'sessions', 'index.db')

export function openBili() {
  if (!existsSync(BILI_DB)) return null
  return new DatabaseSync(BILI_DB, { readOnly: true })
}

const baseId = (id) => String(id).split('|')[0]
const json = (s) => { try { return JSON.parse(s ?? 'null') ?? {} } catch { return {} } }

/** 与 peers（会话 id 列表）同项目的 bili 会话（含 `id|sub:xxx` 子会话） */
export function biliSessions(bdb, peers) {
  const want = new Set(peers.map(baseId))
  return bdb.prepare('select session_id, created_at, stats_json, metadata_json from sessions').all()
    .filter((s) => want.has(baseId(s.session_id)))
}

/**
 * 记忆块 + 时钟。时钟用"消息编号"计：闲置不让记忆变淡，之后又做了多少事才让它变淡。
 * 返回 { blocks, clock: Map<session, 当前最大消息编号>, created: Map<session, 创建时刻> }
 */
export function loadMemory(bdb, peers) {
  const sessions = biliSessions(bdb, peers)
  const clock = new Map(), created = new Map(), blocks = []
  const maxRef = bdb.prepare('select coalesce(max(ref_num), 0) m from refs where session_id=?')
  const rows = bdb.prepare('select block_id, tier, active, created_at, start_ref, end_ref, payload_json from blocks where session_id=?')
  for (const s of sessions) {
    clock.set(s.session_id, maxRef.get(s.session_id).m)
    created.set(s.session_id, s.created_at)
    for (const b of rows.all(s.session_id)) {
      const p = json(b.payload_json)
      blocks.push({
        key: `${s.session_id}#${b.block_id}`, session_id: s.session_id, block_id: b.block_id, tier: b.tier, active: !!b.active,
        created_at: b.created_at, start_ref: b.start_ref, end_ref: b.end_ref,
        topic: String(p.topic ?? ''), summary: String(p.summary ?? ''),
      })
    }
  }
  return { blocks, clock, created }
}

/** 当前上下文 token 与窗口上限（billion-context 记录的真实值） */
export function usage(bdb, sessionId) {
  const s = bdb.prepare('select stats_json, metadata_json from sessions where session_id=?').get(sessionId)
  if (!s) return { tokens: null, window: null }
  const st = json(s.stats_json), md = json(s.metadata_json)
  return { tokens: Number(st.contextTokens) || null, window: Number(md.effectiveContextLimit) || null }
}

// 宿主/插件注入的"用户"消息，不算用户真正说的话
// （bili 消息里真假用户消息字段完全一样，只能按文本开头识别）
export const INJECTED = /^(MNEMON RUNTIME|<system|<memos_memory|<command-|\[dsh-mnemon:|\[回忆|\[遗忘|\[压缩时机|echo-hook received|Caveat:|The following skills|Contents of |Current runtime context|Time sampled while preparing turn|Hook additional context|<[a-z_-]+[>\s])/i

/**
 * 从 bili 的消息表还原最近 n 轮（以用户真正发的消息为一轮的开头）：
 * [{ user, tools: {name: count}, errors, lastReply }]，按时间先后排列
 */
export function recentTurns(bdb, sessionId, n = 3, scan = 4000) {
  const rows = bdb.prepare(`select m.role, m.kind, c.bytes from messages m join content c on c.hash = m.content_hash
                            where m.session_id = ? order by m.seq desc limit ?`).all(sessionId, scan).reverse()
  const turns = []
  let cur = null
  for (const r of rows) {
    const msg = json(Buffer.from(r.bytes).toString('utf8'))
    const text = String(msg.text ?? '')
    if (r.role === 'user' && r.kind === 'text') {
      if (INJECTED.test(text.trim())) continue
      if (cur && cur.user === text.trim().slice(0, 300)) continue   // 重发（同一句的 _1/_2 副本）并入上一轮
      cur = { user: text.trim().slice(0, 300), tools: {}, errors: 0, lastReply: '' }
      turns.push(cur)
      continue
    }
    if (!cur) continue
    if (r.kind === 'tool-call') {
      cur.tools[msg.toolName] = (cur.tools[msg.toolName] ?? 0) + 1
      if (/git (commit|push)|gh pr create/.test(text)) cur.commit = true
    }
    if (r.kind === 'tool-result' && msg.isError) cur.errors++
    if (r.role === 'assistant' && r.kind === 'text' && text.trim()) cur.lastReply = text.trim()
  }
  return turns.slice(-n)
}

// ---------------------------------------------------------------- 写操作只走 billion-context 自己的插件接口（不直接改它的库）
export const PROXY = () => process.env.BILI_PROXY || 'http://127.0.0.1:18787'

/** 调 billion-context 的 compress 工具；它会拒绝不划算的范围，原文不丢 */
export async function compress(sessionId, content, { timeoutMs = 4000 } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${PROXY()}/__bili/plugin/tool`, {
      method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: sessionId, tool: 'compress', args: { content } }),
    })
    const out = await res.json().catch(() => ({}))
    return { status: res.status, outcome: out.outcome ?? out.error ?? null, blocksCreated: out.blocksCreated ?? 0, result: String(out.result ?? out.error ?? '').slice(0, 600) }
  } finally { clearTimeout(timer) }
}

/** 两块之间有没有还没折叠的原始消息（有就不能把它们连成一段一起折，否则会把原文吞进索引） */
export function rawBetween(bdb, sessionId, fromRef, toRef) {
  if (toRef - fromRef <= 1) return false
  const covered = bdb.prepare('select start_ref a, end_ref z from blocks where session_id=? and active=1 and end_ref >= ? and start_ref <= ?').all(sessionId, fromRef + 1, toRef - 1)
  const refs = bdb.prepare('select ref_num n from refs where session_id=? and ref_num > ? and ref_num < ?').all(sessionId, fromRef, toRef)
  return refs.some(({ n }) => !covered.some((c) => c.a <= n && c.z >= n))
}
