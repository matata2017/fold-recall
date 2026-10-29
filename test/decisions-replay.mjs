// test/decisions-replay.mjs — 交接文档 §3.5 的"决策回放"：把本机 state.db 的 decisions 表逐条配回当时的
// 用户原话，重跑本地 route()，比较"旧结论（模型驱动）"与"新结论（A/B/C）"。
//
// 只读：不写 state.db，不发任何网络请求。
// 用法：node test/decisions-replay.mjs
// 注意：decisions 表只存结论不存 prompt，prompt 靠 journal 表 + bili 消息表回补；
//       配对是"按会话内顺序 + journal 原文校正"，属于近似回放，不是逐条精确复现。
import '../lib/quiet.mjs'
import { DatabaseSync } from 'node:sqlite'
import * as E from '../lib/engine.mjs'
import * as M from '../lib/memory.mjs'
import * as B from '../lib/bili.mjs'

const STATE = process.env.FOLD_RECALL_HOME || 'C:/Users/Admin/.fold-recall/state.db'
const BILI = process.env.BILI_INDEX_DB || 'C:/Users/Admin/.local/share/billion-context/sessions/index.db'
const db = new DatabaseSync(STATE, { readOnly: true })
const bdb = new DatabaseSync(BILI, { readOnly: true })

function realUsers(sessionId) {
  const rows = bdb.prepare(`select m.seq,m.role,m.kind,c.bytes from messages m join content c on c.hash=m.content_hash
                            where m.session_id=? order by m.seq`).all(sessionId)
  const out = []
  for (const r of rows) {
    if (r.role !== 'user' || r.kind !== 'text') continue
    let text = ''
    try { text = String(JSON.parse(Buffer.from(r.bytes).toString('utf8')).text ?? '') } catch { text = '' }
    text = text.trim()
    if (!text || B.INJECTED.test(text)) continue          // 宿主注入的"用户"消息不算
    if (out.length && out[out.length - 1].slice(0, 120) === text.slice(0, 120)) continue
    out.push(text)
  }
  return out
}
const usersBySession = new Map()
for (const s of bdb.prepare('select session_id from sessions').all()) usersBySession.set(s.session_id, realUsers(s.session_id))

const decisions = db.prepare('select session_id,turn,ts,json from decisions order by ts').all()
const peers = [...new Set(decisions.map((d) => d.session_id))]

const bySess = new Map()
for (const d of decisions) { if (!bySess.has(d.session_id)) bySess.set(d.session_id, []); bySess.get(d.session_id).push(d) }
const promptOf = new Map()
for (const [sid, list] of bySess) {
  const users = usersBySession.get(sid) ?? []
  list.forEach((d, i) => { if (users[i]) promptOf.set(d.session_id + '#' + d.turn + '#' + d.ts, users[i]) })
}
let jHit = 0, jFix = 0
for (const r of db.prepare('select session_id,turn,json from journal').all()) {
  let u = ''
  try { u = String(JSON.parse(r.json).user ?? '').trim() } catch {}
  if (!u) continue
  const d = (bySess.get(r.session_id) ?? []).find((x) => String(x.turn) === String(r.turn))
  if (!d) continue
  const key = d.session_id + '#' + d.turn + '#' + d.ts
  if (promptOf.get(key)?.slice(0, 60) === u.slice(0, 60)) jHit++
  else { jFix++; promptOf.set(key, u) }
}
console.log(`配对：journal 原文命中=${jHit}，用 journal 原文纠正=${jFix}`)

const RECALL_P = 0.5, RECALL_NONE = 0.05
const rows = []
for (const d of decisions) {
  const prompt = promptOf.get(d.session_id + '#' + d.turn + '#' + d.ts)
  if (!prompt) continue
  const old = JSON.parse(d.json)
  const oldInjected = !!(old.recall?.key && (old.recall.p >= RECALL_P || (old.recall.pNone ?? 1) <= RECALL_NONE))
  const mem = E.loadAll(db, bdb, peers)
  M.score(mem, prompt)
  const cands = M.candidates(mem, 24, { current: d.session_id })
  const r = M.route(mem, prompt, cands)
  rows.push({ ts: new Date(d.ts).toISOString().slice(0, 16), turn: d.turn, old, oldInjected, r, cands: cands.length, prompt: prompt.slice(0, 46).replace(/\s+/g, ' ') })
}

const dist = { A: 0, B: 0, C: 0 }
for (const x of rows) dist[x.r.route]++
console.log(`decisions=${decisions.length} 可回放=${rows.length}  新 route 分布=${JSON.stringify(dist)}`)
console.log(`旧：模型给出 recall 记录=${rows.filter((x) => x.old.recall?.key).length}，其中达到注入阈值=${rows.filter((x) => x.oldInjected).length}`)

console.log('\n旧模型给过 recall 记录、且真的注入过的轮次，与新路由的对照：')
for (const x of rows.filter((y) => y.old.recall?.key)) {
  console.log(`  ${x.ts} t${x.turn} old=${x.old.recall.key} p=${x.old.recall.p?.toFixed?.(2)} pNone=${x.old.recall.pNone?.toFixed?.(2)} 旧注入=${x.oldInjected} → 新 ${x.r.route}${x.r.block ? ' ' + x.r.block.key : ''} | ${x.prompt}`)
}
const newA = rows.filter((x) => x.r.route === 'A')
console.log(`\n新路由 A 的 ${newA.length} 轮：`)
for (const x of newA) console.log(`  ${x.ts} t${x.turn} old=${x.old.recall?.key ?? '-'} → A ${x.r.block?.key} | ${x.prompt}`)

// 首步本地路径耗时（loadAll + score + candidates + route，全程不发网络请求）
const times = []
for (const x of rows.slice(0, 30)) {
  const prompt = promptOf.get(x.session_id + '#' + x.turn + '#' + x.ts)
  const t0 = process.hrtime.bigint()
  const mem = E.loadAll(db, bdb, peers)
  M.score(mem, prompt)
  const cands = M.candidates(mem, 24, { current: x.session_id })
  M.route(mem, prompt, cands)
  times.push(Number(process.hrtime.bigint() - t0) / 1e6)
}
times.sort((a, b) => a - b)
const pct = (p) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)]
console.log(`\n首步本地路径（无网络）n=${times.length} 中位=${times[Math.floor(times.length / 2)].toFixed(1)}ms P90=${pct(90).toFixed(1)}ms max=${times[times.length - 1].toFixed(1)}ms  （交接文档要求 P90 < 300ms）`)
db.close(); bdb.close()
