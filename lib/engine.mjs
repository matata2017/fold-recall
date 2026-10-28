// engine.mjs — 每条用户消息走一遍：提起 → 回忆 → 压缩时机 → 遗忘；以及后台整理（类型/重要性/前后关系）
import * as S from './store.mjs'
import * as B from './bili.mjs'
import * as D from './decide.mjs'
import * as M from './memory.mjs'
import * as R from './rawindex.mjs'

export const MIN_TURN = 3, MIN_TOKENS = 40000, TIMING_COOLDOWN = 3, FORGET_COOLDOWN = 300
export const RECALL_P = 0.5, RECALL_NONE = 0.05  // 选中的一段 ≥ 0.5；或"都不需要" ≤ 0.05（确实要旧记忆，只是相似的段太多、概率被摊薄）
// 遗忘：auto 后台直接折成索引（默认，不打扰对话）· hint 注入提示让模型做 · off 只记录
// 压缩时机：off 只记录判断（默认；billion-context 自己会按增长提醒压缩）· hint 注入提示
const forgetMode = () => process.env.FOLD_RECALL_FORGET || 'auto'
const timingMode = () => process.env.FOLD_RECALL_TIMING || 'off'

/** 按"中间没有未折叠原文"把遗忘段再切开 */
function splitOnRaw(bdb, sessionId, runs) {
  const out = []
  for (const r of runs) {
    let cur = [r[0]]
    for (let i = 1; i < r.length; i++) {
      if (B.rawBetween(bdb, sessionId, Number(r[i - 1].end_ref), Number(r[i].start_ref))) { out.push(cur); cur = [r[i]] } else cur.push(r[i])
    }
    out.push(cur)
  }
  return out
}

/** 载入同项目的全部记忆并算好强度 */
export function loadAll(db, bdb, peers) {
  const mem = B.loadMemory(bdb, peers)
  M.annotate(mem, S.metaMap(db), S.eventsFor(db), S.supersededSet(db))
  return mem
}

function evidence(turns, prompt) {
  const prev = turns.slice(-3)
  const last = prev[prev.length - 1] ?? { lastReply: '' }
  const lines = ['【新请求】' + D.oneLine(prompt).slice(0, 300)]
  prev.forEach((p, i) => {
    const tools = Object.entries(p.tools).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`).join(' ') || '无'
    lines.push(`【前第${prev.length - i}轮请求】${D.oneLine(p.user).slice(0, 200)}；工具：${tools}；报错 ${p.errors} 次`)
  })
  lines.push('【上一轮是否执行了 git 提交/推送/提 PR】' + (last.commit ? '是' : '否'))
  lines.push('【上一轮智能体最后的回复（结尾部分）】' + String(last.lastReply ?? '').slice(-400))
  return lines.join('\n')
}

/**
 * 一条新消息。返回 { context: 要注入的文本（可能为空）, decision: 记录 }
 * opts.dryRun：只看不记（不写事件、不更新冷却）
 */
export async function onPrompt(db, bdb, { sessionId, turn, prompt, peers, timeoutMs = 5000, dryRun = false }) {
  const t0 = Date.now()
  const mem = loadAll(db, bdb, peers)
  const clock = mem.clock.get(sessionId) ?? 0
  M.score(mem, prompt)
  const dec = { blocks: mem.blocks.length }

  // 1) 被提起的记忆变牢
  const ment = M.mentioned(mem)
  dec.mentioned = ment.map((b) => b.key)
  if (!dryRun) for (const b of ment) S.addEvent(db, b.key, 'mention', M.MENTION_C, sessionId, clock)

  // 2) 本轮要问的题。候选除了摘要的字面相关，还看原文索引（先把新消息补进索引；索引是缓存，试运行也补）
  const questions = {}
  if (mem.enough && R.enabled()) {
    const sids = B.biliSessions(bdb, peers).map((s) => s.session_id)
    try { R.indexSessions(db, bdb, sids, { budget: R.INDEX_BUDGET }); mem.rawHits = R.rawHits(db, sids, prompt) } catch (e) { dec.raw_error = e.message }
  }
  const cands = M.candidates(mem, D.MAX_OPTIONS, { current: sessionId })
  for (const b of cands) if (b.rawRef != null) b.rawSnippet = R.snippet(bdb, b.session_id, b.rawRef, mem.rawHits.terms)
  dec.raw = cands.filter((b) => b.rawSnippet).length
  if (cands.length) { questions.recall = D.recallQuestion(cands); questions.latest = D.latestQuestion(cands) }
  dec.candidates = cands.length

  const { tokens, window } = B.usage(bdb, sessionId)
  const hints = S.getHints(db, sessionId)
  const n = Number(turn)
  const timingGate = !(Number.isInteger(n) && n < MIN_TURN) && (tokens ?? 0) >= MIN_TOKENS &&
    !(hints.last_timing_ref != null && Number.isInteger(n) && n > hints.last_timing_ref && n - hints.last_timing_ref < TIMING_COOLDOWN)
  const turns = B.recentTurns(bdb, sessionId, 4)
  if (turns.length && D.oneLine(turns[turns.length - 1].user) === D.oneLine(prompt).slice(0, 300)) turns.pop()   // 新消息已被代理收录
  if (timingGate && turns.length) Object.assign(questions, D.TIMING)
  Object.assign(dec, { tokens, window, timing_asked: !!questions.done })

  const parts = []
  if (Object.keys(questions).length) {
    try {
      const { answers, latencyMs } = await D.ask(evidence(turns, prompt), questions, { timeoutMs })
      dec.latency_ms = latencyMs
      // 回忆：选中的一段 + 同一件事里最新的一段
      if (questions.recall) {
        const { block, p, pNone } = D.recallPick(answers, cands)
        dec.recall = { key: block?.key ?? null, p, pNone }
        const lt = D.recallPick(answers, cands, 'latest')
        dec.latest = { key: lt.block?.key ?? null, p: lt.p, pNone: lt.pNone }
        if (block && (p >= RECALL_P || pNone <= RECALL_NONE)) {
          // 问的是进展/结果：再带上"最新进展"那段（决策模型选的，或沿后续链找到的）
          const latest = lt.block && lt.p >= 0.4 ? lt.block : M.latestInThread(mem, S.linksFrom(db), block)
          const picked = latest.key !== block.key ? [block, latest] : [block]
          parts.push(M.recallText(sessionId, picked))
          dec.recalled = picked.map((b) => b.key)
          const deferred = picked.filter((b) => M.deferTypes().has(b.type)).map((b) => b.key)
          if (deferred.length) dec.deferred = deferred                    // 结论类：只给指引，内容交给记忆插件
          if (!dryRun) for (const b of picked) S.addEvent(db, b.key, 'recall', M.RECALL_C, sessionId, clock)
        }
      }
      if (questions.done) {
        const v = D.timingVerdict(answers)
        dec.timing = v
        if (v?.tier) {
          if (timingMode() === 'hint') parts.push(M.timingText(v, tokens && window ? (tokens / window) * 100 : NaN))
          if (!dryRun && Number.isInteger(n)) S.setHint(db, sessionId, 'last_timing_ref', n)
        }
      }
    } catch (e) {
      dec.error = e.name === 'AbortError' ? 'timeout' : e.message          // 判断失败：不注入回忆与时机提示
    }
  }

  // 3) 遗忘：不需要问模型——强度、类型、是否钉住都已算好
  const lastForget = hints.last_forget_ref
  if (forgetMode() !== 'off' && (lastForget == null || clock - lastForget >= FORGET_COOLDOWN)) {
    // 这一轮刚被提起、刚被找回的块不能同时被遗忘
    const fresh = new Set([...(dec.recalled ?? []), ...dec.mentioned])
    for (const b of mem.blocks) if (fresh.has(b.key)) b.keep = Infinity
    const runs = M.forgetRuns(mem, sessionId)
    if (runs.length) {
      dec.forget = { blocks: runs.flat().map((b) => b.block_id), mode: forgetMode() }
      if (forgetMode() === 'hint') parts.push(M.forgetText(runs))
      else if (!dryRun) {
        try {
          const r = await B.compress(sessionId, M.forgetIndex(splitOnRaw(bdb, sessionId, runs)))
          Object.assign(dec.forget, { outcome: r.outcome, blocksCreated: r.blocksCreated, result: r.result.slice(0, 300) })
        } catch (e) { dec.forget.error = e.name === 'AbortError' ? 'timeout' : e.message }
      }
      if (!dryRun) S.setHint(db, sessionId, 'last_forget_ref', clock)
    }
  }

  dec.unjudged = mem.blocks.filter((b) => b.type == null).length
  dec.total_ms = Date.now() - t0
  if (!dryRun) S.logDecision(db, sessionId, turn, dec)
  return { context: parts.join('\n\n'), decision: dec, mem }
}

// ---------------------------------------------------------------- 整理（后台）
/** 前一段的候选：同会话紧挨着的上一块 + 更早的相关块（相关度 ≥ 0.2），最多 24 个 */
function prevCandidates(mem, b, idf) {
  const earlier = mem.blocks.filter((x) => x.key !== b.key && x.topic && x.created_at <= b.created_at)
  const sameSession = earlier.filter((x) => x.session_id === b.session_id).sort((x, y) => y.created_at - x.created_at || y.block_id.localeCompare(x.block_id))
  const out = sameSession.slice(0, 1)
  const q = M.grams(b.topic + ' ' + b.summary.slice(0, 600))
  const rel = earlier.filter((x) => !out.includes(x)).map((x) => ({ x, r: M.relevance(q, x, idf) }))
    .filter((y) => y.r >= 0.2).sort((p, q2) => q2.r - p.r).slice(0, D.MAX_OPTIONS - out.length).map((y) => y.x)
  return [...out, ...rel]
}

export async function consolidate(db, bdb, peers, { limit = 40, concurrency = 4, log = () => {} } = {}) {
  if (R.enabled()) try { R.indexSessions(db, bdb, B.biliSessions(bdb, peers).map((s) => s.session_id)) } catch (e) { log('原文索引失败：' + e.message) }   // 后台补全原文索引
  const mem = loadAll(db, bdb, peers)
  const idf = M.indexBlocks(mem.blocks)
  const todo = mem.blocks.filter((b) => b.type == null).sort((a, b) => b.created_at - a.created_at).slice(0, limit)
  const upMeta = db.prepare('insert or replace into meta values (?,?,?,?,?,?)')
  const upLink = db.prepare('insert or replace into links values (?,?,?,?)')
  let done = 0, failed = 0
  async function one(b) {
    if (!b.summary.trim() && !b.topic.trim()) { upMeta.run(b.key, 'noise', 0, 0, 0, Date.now()); done++; return }
    const prev = prevCandidates(mem, b, idf)
    const state = `【记忆块】${b.block_id}（${new Date(b.created_at).toISOString().slice(0, 10)}）\n【主题】${b.topic}\n【摘要】${b.summary.slice(0, 1800)}`
    try {
      const { answers } = await D.ask(state, D.consolidateQuestions(prev), { timeoutMs: 30000, retries: 2 })
      const v = D.consolidateVerdict(answers, prev)
      if (!v) throw new Error('bad_answer')
      upMeta.run(b.key, v.type, v.pKey, v.pUseful, b.summary.length, Date.now())
      if (v.prev) upLink.run(b.key, v.prev.key, 'thread', v.pPrev)
      done++
      log(`${b.block_id.padEnd(5)} ${v.type.padEnd(10)} key=${v.pKey.toFixed(2)} ${v.prev ? '← ' + v.prev.block_id : ''}  ${b.topic.slice(0, 40)}`)
    } catch (e) { failed++; log(`${b.block_id} 失败：${e.message}`) }
  }
  const queue = [...todo]
  await Promise.all(Array.from({ length: concurrency }, async () => { while (queue.length) await one(queue.shift()) }))
  return { done, failed, left: mem.blocks.filter((b) => b.type == null).length - done }
}
