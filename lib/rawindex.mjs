/**
 * rawindex.mjs — 原文检索：给 billion-context 的原始消息建 SQLite FTS5 三字索引（trigram）。
 *
 * 回忆候选原本只看块的主题和摘要；摘要是模型写的，会丢细节（变量名、文件名、报错原文、某句原话）。
 * 这里对原文建索引，命中的消息映射回盖住它的那个块，作为额外的候选来源，并带上命中的原文片段给决策模型看。
 *
 * - 只补充，不替换：三字索引查不了两个字的中文词（"部署"），中文短词仍靠 memory.mjs 的二字组相关度。
 * - 只索引真用户消息、助手回复、工具调用（命令、路径），不索引工具输出与思考过程；每条截断。
 * - 无内容索引（content=''）：只存索引，不再复制一份原文；片段按需从 billion-context 的库里取。
 * - 增量：按会话记录已索引到的消息序号。钩子里每次最多补 INDEX_BUDGET 条，其余交给后台整理或 `index` 命令。
 */
import * as B from './bili.mjs'

export const enabled = () => process.env.FOLD_RECALL_RAW !== 'off'
export const INDEX_BUDGET = 400
export const RAW_N = 4                      // 最多补几个原文命中的块进候选
const CAP = { user: 2000, assistant: 2000, 'tool-call': 600 }

export function ensureSchema(db) {
  db.exec(`create virtual table if not exists raw_fts using fts5(text, tokenize='trigram', content='');
           create table if not exists raw_map (id integer primary key, session_id text, ref integer);
           create table if not exists raw_progress (session_id text primary key, seq integer);`)
}

const json = (s) => { try { return JSON.parse(s) ?? {} } catch { return {} } }

/** 把这些会话里还没索引的消息补进索引；返回本次索引的条数 */
export function indexSessions(db, bdb, sessionIds, { budget = Infinity } = {}) {
  ensureSchema(db)
  const prog = db.prepare('select seq from raw_progress where session_id=?')
  const setProg = db.prepare('insert or replace into raw_progress values (?,?)')
  const insMap = db.prepare('insert into raw_map (session_id, ref) values (?,?)')
  const insFts = db.prepare('insert into raw_fts (rowid, text) values (?,?)')
  const rows = bdb.prepare(`select m.seq, m.ref_num, m.role, m.kind, c.bytes from messages m join content c on c.hash = m.content_hash
                            where m.session_id = ? and m.seq > ? and m.kind in ('text', 'tool-call') and m.role in ('user', 'assistant')
                            order by m.seq limit ?`)
  let n = 0
  for (const sid of sessionIds) {
    if (n >= budget) break
    const from = prog.get(sid)?.seq ?? 0
    const batch = rows.all(sid, from, Math.min(budget - n, 5000))
    if (!batch.length) continue
    db.exec('begin')
    try {
      for (const r of batch) {
        const text = String(json(Buffer.from(r.bytes).toString('utf8')).text ?? '').trim()
        const skip = !text || (r.role === 'user' && B.INJECTED.test(text))
        if (!skip) {
          const id = insMap.run(sid, r.ref_num).lastInsertRowid
          insFts.run(id, text.slice(0, CAP[r.kind === 'tool-call' ? 'tool-call' : r.role]))
          n++
        }
      }
      setProg.run(sid, batch.at(-1).seq)
      db.exec('commit')
    } catch (e) { db.exec('rollback'); throw e }
  }
  return n
}

/** 查询词：英文/标识符/路径 ≥3 个字符；中文连续 ≥3 个字时取每个三字片段（排序交给 bm25） */
export function queryTerms(prompt) {
  const t = String(prompt ?? '')
  const terms = new Set((t.match(/[A-Za-z0-9_][A-Za-z0-9_.\-/]{2,}/g) ?? []).map((x) => x.toLowerCase()))
  for (const run of t.match(/[一-鿿]{3,}/g) ?? []) for (let i = 0; i + 3 <= run.length; i++) terms.add(run.slice(i, i + 3))
  return [...terms].slice(0, 40)
}

const quote = (x) => `"${x.replace(/"/g, '""')}"`
/**
 * 查询词再筛一遍：到处都有的词（"为什么""怎么做""的问题"，超过 1% 的消息里都有）像停用词，去掉；
 * 一条都没命中的也去掉。返回从少见到常见排好的词。
 */
export function usefulTerms(db, prompt) {
  ensureSchema(db)
  const total = db.prepare('select count(*) n from raw_map').get().n
  const df = db.prepare('select count(*) n from raw_fts where raw_fts match ?')
  return queryTerms(prompt).map((t) => ({ t, n: df.get(quote(t)).n }))
    .filter((x) => x.n > 0 && x.n <= Math.max(5, total * 0.01)).sort((a, b) => a.n - b.n)
    .map((x) => ({ ...x, w: Math.log(1 + total / x.n) * (/^[a-z0-9_.\-/]+$/.test(x.t) ? 2 : 1) }))   // 越少见越重；英文/标识符多是名字，加倍
}

/**
 * 原文命中：每个词单独查（各取最相关的 perTerm 条），[{ session_id, ref, term, w }]；
 * 块的得分 = 它命中的不同词的权重之和（见 memory.mjs rawBlocks），而不是命中条数——一个常见词命中一百条也不该压过一个少见的名字。
 * hits.terms：实际用的查询词（少见的在前）；hits.weight：全部词的权重和。
 */
export function rawHits(db, sessionIds, prompt, perTerm = 50) {
  const terms = sessionIds.length ? usefulTerms(db, prompt) : []
  const out = Object.assign([], { terms: terms.map((x) => x.t), weight: terms.reduce((s, x) => s + x.w, 0) })
  if (!terms.length) return out
  try {
    const stmt = db.prepare(`select m.session_id, m.ref from raw_fts join raw_map m on m.id = raw_fts.rowid
                             where raw_fts match ? and m.session_id in (${sessionIds.map(() => '?').join(',')}) order by bm25(raw_fts) limit ?`)
    for (const { t, w, n } of terms) for (const r of stmt.all(quote(t), ...sessionIds, perTerm)) out.push({ ...r, term: t, w, df: n })
  } catch {}
  return out
}

/** 命中消息的原文片段：取最少见的查询词出现的位置前后（terms 用 rawHits 返回的 hits.terms） */
export function snippet(bdb, sessionId, ref, terms, width = 60) {
  const r = bdb.prepare(`select c.bytes from messages m join content c on c.hash = m.content_hash where m.session_id=? and m.ref_num=? and m.kind in ('text','tool-call') limit 1`).get(sessionId, ref)
  if (!r) return ''
  const text = String(json(Buffer.from(r.bytes).toString('utf8')).text ?? '').replace(/\s+/g, ' ')
  const low = text.toLowerCase()
  const at = terms.map((x) => low.indexOf(x)).find((i) => i >= 0) ?? 0
  const a = Math.max(0, at - width / 3)
  return (a > 0 ? '…' : '') + text.slice(a, a + width) + (a + width < text.length ? '…' : '')
}
