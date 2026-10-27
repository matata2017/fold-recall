/**
 * memory.mjs — 像人一样的记忆：越久没用越淡，常被提起的越牢，重要的不忘。
 *
 * 记忆单元 = billion-context 折叠出的块（主题 + 摘要 + 原文范围；原文永远在它的库里）。
 * 强度（ACT-R 基础激活的强度形式）：w = Σ_i c_i · (age_i + 1)^-0.5
 *   i 取：块的创建（c=1）、每次被提起（mention，c=0.5）、每次被找回（recall，c=1）
 *   age 以"之后又经过的消息条数"计：闲置几天不会让记忆变淡，之后又做了多少事才会。
 * 钉住（不遗忘）：类型为 preference（偏好/约定/长期指令），或重要性 P(key) ≥ PIN_KEY。
 * 保持度 keep = w本会话 × (1 + P(key))，噪声再减半：越重要忘得越慢（钉住之外的连续版本）；
 *   w本会话 只按本会话经过的消息算，见 ageSince。
 * 遗忘：当前会话仍在上下文里的块，类型是过程（episode）或噪声（noise）、未钉住、保持度 < FORGET_W；
 *   知识与偏好/约定一律不忘（保守：忘错了模型察觉不到；它们留给 billion-context 自己的分层蒸馏）
 *   → 后台经 billion-context 的 compress 折成只列主题的索引块，拿出上下文；被问起时由回忆从库里找回。
 */
export const FORGET_W = 1500 ** -0.5          // ≈ "1500 条消息没被用到"
export const FORGETTABLE = new Set(['episode', 'noise'])
export const PIN_KEY = 0.8                 // 实测 P(key) 中位数 0.55：决策模型认为大部分工作都"重要"，只钉最高的一成
export const MENTION_REL = 0.28, MENTION_MAX = 3, MENTION_C = 0.5, RECALL_C = 1
export const RECALL_REL = 0.15

/**
 * 某时刻（会话 sid 的第 ref 条消息、墙钟 ts）之后又经过了多少条消息。
 * local=false：项目时钟——之后新开的同项目会话整段计入（用于回忆排序）
 * local=true ：会话时钟——只数本会话（用于遗忘：恢复一个旧会话时，它眼前的东西不该因为别的会话做了事而被挤掉）
 */
export function ageSince(mem, sid, ref, ts, local = false) {
  let age = Math.max(0, (mem.clock.get(sid) ?? ref) - ref)
  if (!local) for (const [other, c] of mem.clock) if (other !== sid && (mem.created.get(other) ?? 0) > ts) age += c
  return age
}

const refNum = (r) => { const m = /(\d+)/.exec(String(r ?? '')); return m ? Number(m[1]) : 0 }

/** 给每块算强度，并挂上整理结果（meta）与是否钉住 */
export function annotate(mem, meta, events) {
  const byKey = new Map()
  for (const e of events) (byKey.get(e.key) ?? byKey.set(e.key, []).get(e.key)).push(e)
  for (const b of mem.blocks) {
    const m = meta.get(b.key)
    b.type = m?.type ?? null
    b.pKey = m?.p_key ?? null
    b.pinned = !!m && (m.type === 'preference' || (m.p_key ?? 0) >= PIN_KEY)
    const ev = byKey.get(b.key) ?? []
    const strength = (local) => {
      let w = (ageSince(mem, b.session_id, refNum(b.end_ref), b.created_at, local) + 1) ** -0.5
      for (const e of ev) {
        if (local && e.session_id !== b.session_id) continue
        w += (e.weight ?? 1) * (ageSince(mem, e.session_id, e.ref ?? 0, e.ts, local) + 1) ** -0.5
      }
      return w
    }
    b.w = strength(false)
    b.keep = strength(true) * (1 + (b.pKey ?? 0)) * (b.type === 'noise' ? 0.5 : 1)
    b.mentions = ev.filter((e) => e.kind === 'mention').length
    b.recalls = ev.filter((e) => e.kind === 'recall').length
  }
  return mem.blocks
}

// ---------------------------------------------------------------- 相关度（不依赖向量库）
// 中文按相邻二字组、英文/数字按词；按逆文档频率加权，"继续""看下"这类到处都有的词几乎不算分
export function grams(s) {
  const t = String(s ?? '').toLowerCase()
  const out = new Set(t.match(/[a-z0-9_.-]{2,}/g) ?? [])
  for (const seg of t.replace(/[^一-鿿]+/g, ' ').split(' ')) for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2))
  return out
}
export function indexBlocks(blocks) {
  const df = new Map()
  for (const b of blocks) {
    b.g = grams(b.topic + ' ' + b.summary)
    b.tg = grams(b.topic)
    for (const g of b.g) df.set(g, (df.get(g) ?? 0) + 1)
  }
  const n = Math.max(blocks.length, 1)
  const cap = Math.log(1 + n / 3)                      // 只出现一两次的二字组（"后通""通了"）多是虚词拼接，封顶
  // 记忆库里从没出现过的词（"当时""怎么"）不计分也不扣分：返回 0；英文/标识符多是名字（hindsight、SELF_ID），加倍
  const idf = (g) => (df.has(g) ? Math.min(Math.log(1 + n / df.get(g)), cap) * (isName(g) ? 2 : 1) : 0)
  idf.df = (g) => df.get(g) ?? 0
  return idf
}
const isName = (g) => /^[a-z0-9_.-]+$/.test(g)

/** 内容相同的块（复制/恢复出的会话会继承同样的块）只算一份，免得候选重复、把概率摊薄 */
export const contentKey = (b) => b.topic + '\u0000' + b.summary.slice(0, 300)
/** 新消息里（记忆库认得的）词，有多大比重落在这块里；落在主题里的算双倍。hits = 命中的词数 */
export function relevance(q, b, idf) {
  let tot = 0, hit = 0, hits = 0
  for (const g of q) {
    const w = idf(g); if (!w) continue
    tot += w
    if (b.g.has(g)) { hit += b.tg?.has(g) ? w : w / 2; hits++ }
  }
  b.hits = hits
  return tot ? hit / tot : 0
}

/** 每块的相关度；消息里记忆库认得的词少于 2 个时（"继续""好的"）不算，不触发回忆 */
export function score(mem, prompt) {
  const idf = indexBlocks(mem.blocks)
  const q = grams(prompt)
  const known = [...q].filter((g) => idf(g) > 0)
  // 认得的词 ≥ 2 个才算有内容；只有一个时，它得是个少见的名字（"cmux 是个啥来着"）
  const enough = known.length >= 2 || known.some((g) => isName(g) && /[a-z]/.test(g) && idf.df(g) <= 3)
  for (const b of mem.blocks) b.rel = enough ? relevance(q, b, idf) : (b.hits = 0)
  mem.known = known.length
  mem.enough = enough
  return mem.blocks
}

/** 被提起：命中 ≥ 2 个词、相关度 ≥ MENTION_REL 的最相关几块，记一次"提起"——常被提起的记忆变牢 */
export function mentioned(mem) {
  return mem.blocks.filter((b) => b.rel >= MENTION_REL && b.hits >= 2 && b.topic && b.type !== 'noise')
    .sort((a, b) => b.rel - a.rel).slice(0, MENTION_MAX)
}

/**
 * 回忆候选（最多 24 个，交给决策模型挑）：
 *  1. 字面相关的：相关度 × (0.5 + 0.5 × 归一化强度)，钉住的 ×1.2
 *  2. 字面相关前几块的"下一段"（同会话紧接着的那块）——问"最后怎么样了"，答案常在后一段
 *  3. 最近最牢的几块——人回忆时，最近的事先浮上来，即使字面上对不上
 */
export function candidates(mem, max = 24, { recent = 6, nextOf = 5, current = null } = {}) {
  if (!mem.enough) return []
  const wmax = Math.max(...mem.blocks.map((b) => b.w), 1e-9)
  // 同样内容的块只留一份：优先当前会话的，其次仍在上下文里的，再次最新的
  const rank = (b) => [b.session_id === current ? 1 : 0, b.active ? 1 : 0, b.created_at]
  const better = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false }
  const keep = new Map()
  for (const b of mem.blocks) {
    const k = contentKey(b), o = keep.get(k)
    if (!o || better(b, o)) keep.set(k, b)
  }
  const usable = (b) => b.topic && b.type !== 'noise' && keep.get(contentKey(b)) === b
  const lexical = mem.blocks.filter((b) => usable(b) && b.rel >= RECALL_REL && b.hits >= 1)
    .map((b) => ({ b, s: b.rel * (0.5 + 0.5 * b.w / wmax) * (b.pinned ? 1.2 : 1) }))
    .sort((x, y) => y.s - x.s).map((x) => x.b)
  if (!lexical.length) return []
  const bySession = new Map()
  for (const b of mem.blocks) (bySession.get(b.session_id) ?? bySession.set(b.session_id, []).get(b.session_id)).push(b)
  for (const list of bySession.values()) list.sort((a, b) => refNum(a.start_ref) - refNum(b.start_ref) || a.created_at - b.created_at)
  const next = (b) => {
    const list = bySession.get(b.session_id)
    const after = list.filter((x) => usable(x) && refNum(x.start_ref) > refNum(b.end_ref))
    return after[0]
  }
  const out = [], seen = new Set()
  const add = (b) => { if (b && !seen.has(b.key) && out.length < max) { seen.add(b.key); out.push(b) } }
  const lexN = Math.max(max - recent - nextOf, 8)
  lexical.slice(0, lexN).forEach(add)
  lexical.slice(0, nextOf).forEach((b) => add(next(b)))
  mem.blocks.filter(usable).sort((a, b) => b.w - a.w).slice(0, recent).forEach(add)
  lexical.slice(lexN).forEach(add)
  return out
}

/** 沿"后续"链找到这件事最新的一段（问"最后怎么样了"时，答案在最新的那段里） */
export function latestInThread(mem, links, block) {
  const next = new Map()
  for (const l of links) if (l.kind === 'thread') (next.get(l.to_key) ?? next.set(l.to_key, []).get(l.to_key)).push(l.from_key)
  const byKey = new Map(mem.blocks.map((b) => [b.key, b]))
  let cur = block, best = block
  const seen = new Set([block.key])
  for (;;) {
    const kids = (next.get(cur.key) ?? []).map((k) => byKey.get(k)).filter((b) => b && !seen.has(b.key))
    if (!kids.length) return best
    cur = kids.sort((a, b) => b.created_at - a.created_at)[0]
    seen.add(cur.key)
    if (cur.type !== 'noise' && cur.topic) best = cur                        // 噪声块只当路过，不当结果
  }
}

/** 遗忘候选：当前会话仍在上下文里、类型是过程或噪声、未钉住、保持度 < FORGET_W；按原文位置连成段 */
export function forgetRuns(mem, current, { minBlocks = 3, maxBlocks = 12 } = {}) {
  const cur = mem.blocks.filter((b) => b.session_id === current && b.active && b.end_ref != null)
    .sort((a, b) => refNum(a.start_ref) - refNum(b.start_ref))
  const ok = (b) => FORGETTABLE.has(b.type) && !b.pinned && b.keep < FORGET_W
  const runs = []
  let run = []
  for (const b of cur) {
    if (ok(b)) run.push(b)
    else { if (run.length) runs.push(run); run = [] }
  }
  if (run.length) runs.push(run)
  const total = runs.reduce((s, r) => s + r.length, 0)
  if (total < minBlocks) return []
  // 一次只提示最早的 maxBlocks 块，免得提示本身太长
  const out = []
  let left = maxBlocks
  for (const r of runs) { if (left <= 0) break; out.push(r.slice(0, left)); left -= r.length }
  return out
}

// ---------------------------------------------------------------- 注入文本
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '?')

/** 回忆只注入一两行：是哪段旧事、去哪展开；不在眼前的块附一小段摘要 */
export function recallText(current, picked) {
  const lines = picked.map((b) => {
    if (b.session_id === current && b.active) return `- ${b.block_id}「${b.topic}」：已折叠，要细节先 decompress ${b.block_id}`
    const where = b.session_id === current ? '本会话' : '会话 ' + b.session_id.slice(0, 16) + '…'
    return `- 「${b.topic}」（${day(b.created_at)}，${where} ${b.block_id}）：${b.summary.replace(/\s+/g, ' ').slice(0, 400)}`
  })
  return ['[回忆 · fold-recall] 这条消息涉及较早的工作：', ...lines].join('\n')
}

/** 遗忘由 fold-recall 自己执行：每段合成一个只列主题的索引块（billion-context 的 compress，内含原来的块，可 decompress 找回） */
export function forgetIndex(runs) {
  const pad = (r) => 'm' + String(refNum(r)).padStart(5, '0')
  return runs.map((r) => [`${pad(r[0].start_ref)}–${pad(r[r.length - 1].end_ref)} 旧工作索引（fold-recall 遗忘，${r.length} 段）`,
    ...r.map((b) => `- ${b.block_id}「${b.topic.slice(0, 60)}」${day(b.created_at)}`),
    '细节已移出上下文；需要时用 decompress 或 search_context 找回。'].join('\n')).join('\n')
}

export function forgetText(runs) {
  const pad = (r) => String(refNum(r)).padStart(5, '0')
  const lines = runs.map((r) => `- m${pad(r[0].start_ref)}–m${pad(r[r.length - 1].end_ref)}：${r.map((b) => `${b.block_id}「${b.topic.slice(0, 24)}」`).join('、')}`)
  return ['[遗忘 · fold-recall] 下面这些旧摘要块很久没用到了（记忆强度很低，且不是偏好、约定或关键结论）。请调用 compress 把每一段合并成一个简短的索引块：只留一行"主题"，不保留细节。',
          '原文仍完整保存在长期记忆里，之后被问到时会自动找回。没有 compress 工具时忽略本条。', ...lines].join('\n')
}

export function timingText(v, usagePct) {
  const pct = Number.isFinite(usagePct) ? `，当前上下文已用 ${usagePct.toFixed(0)}%` : ''
  const head = v.tier === 'switch'
    ? `[压缩时机 · fold-recall] 用户的新请求是一项和之前工作不同的新任务（把握 ${(v.pNew * 100).toFixed(0)}%${pct}），之前那项工作可能还没做完。`
    : `[压缩时机 · fold-recall] 之前那项工作已告一段落，用户的新请求是一项新任务（得分 ${v.s2.toFixed(2)}${pct}）。`
  return [head,
    '开始新任务之前，请先调用 compress 工具，把之前那项工作的历史折叠成摘要。摘要必须保留：',
    '- 用户提出的要求、偏好与约定（原话要点）；已确认的结论、改动过的文件与位置；',
    '- 已提交/未提交的状态，以及正在等待的外部结果；',
    '- 尚未完成的事项和原定的下一步——用户之后可能会切回来继续。',
    '如果你判断之前的细节对新任务仍然必要，可以不压缩，并用一句话说明原因。没有 compress 工具时忽略本条。'].join('\n')
}
