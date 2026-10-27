/**
 * repair.mjs — 修复"会话继承"：宿主换了会话 id（DSH 重启后恢复会话、复制会话）时，billion-context 本应把
 * 父会话的折叠状态接过来；历史里有图片等非文本内容时继承会降级，子会话只接到一部分块，剩下的几十万 token
 * 只能靠请求前现场压缩（慢、会超时、可能超窗）。
 *
 * 修法不另起炉灶：把父会话里模型当初写好的摘要，用 billion-context 自己的 compress 工具重新套到子会话的
 * 相同范围上（不调模型，几秒完成；原文仍在库里，可 decompress）。
 */
const json = (s) => { try { return JSON.parse(s ?? 'null') ?? {} } catch { return {} } }
const pad = (n) => 'm' + String(n).padStart(5, '0')
export const MIN_SUMMARY = 300          // 太短的摘要（指针块、噪声快照）不拿来替换大段原文
export const MIN_REFS = 5

/** 子会话的父会话（billion-context 记在 metadata.derivedFrom） */
export function parentOf(bdb, child) {
  const s = bdb.prepare('select metadata_json from sessions where session_id=?').get(child)
  const md = json(s?.metadata_json)
  return md.derivedFromSessionId || md.derivedFrom || null
}

const activeBlocks = (bdb, sid) => bdb.prepare('select block_id, start_ref a, end_ref z, payload_json p from blocks where session_id=? and active=1 and start_ref is not null order by start_ref').all(sid)
  .map((b) => ({ ...b, ...(({ topic, summary }) => ({ topic: String(topic ?? ''), summary: String(summary ?? '') }))(json(b.p)) }))

/** [a,z] 去掉被 covers 占住的部分，返回剩下的最长一段 */
function largestGap(a, z, covers) {
  let segs = [[a, z]]
  for (const c of covers) {
    segs = segs.flatMap(([s, e]) => (c.z < s || c.a > e) ? [[s, e]] : [[s, c.a - 1], [c.z + 1, e]].filter(([x, y]) => x <= y))
  }
  return segs.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0] ?? null
}

/**
 * 修复计划：父会话的每个块，在子会话里还没被覆盖的那部分（去掉子会话已有块、以及本计划已占的范围，取最长一段），
 * 首尾对齐到子会话里真实存在的消息编号。摘要越详细的块越先占范围，指针块/索引块只填剩下的。
 */
export function repairPlan(bdb, child, parent = parentOf(bdb, child)) {
  if (!parent) return { parent: null, entries: [], skipped: [] }
  const pa = activeBlocks(bdb, parent).sort((x, y) => y.summary.length - x.summary.length)
  const covers = activeBlocks(bdb, child).map(({ a, z }) => ({ a, z }))
  const span = bdb.prepare('select min(ref_num) s, max(ref_num) e, count(*) n from refs where session_id=? and ref_num between ? and ?')
  const entries = [], skipped = []
  for (const b of pa) {
    const gap = largestGap(b.a, b.z, covers)
    const r = gap && span.get(child, gap[0], gap[1])
    if (!r?.n || r.n < MIN_REFS) continue                                   // 已被覆盖（或只剩零星几条）
    if (b.summary.trim().length < MIN_SUMMARY) { skipped.push({ ids: b.block_id, why: `摘要太短（${b.summary.trim().length} 字），不拿来替换 ${r.n} 条消息` }); continue }
    entries.push({ ids: b.block_id, a: r.s, z: r.e, refs: r.n, topic: b.topic, summary: b.summary.trim() })
    covers.push({ a: r.s, z: r.e })
  }
  entries.sort((x, y) => x.a - y.a)
  return { parent, entries, skipped }
}

export const repairContent = (entries) => entries.map((e) => `${pad(e.a)}–${pad(e.z)} ${e.topic}\n${e.summary}`).join('\n')

/** 通过 billion-context 的插件接口执行 compress（它会拒绝不划算的范围，原文不丢） */
export async function applyRepair(entries, child, { proxy = process.env.BILI_PROXY || 'http://127.0.0.1:18787' } = {}) {
  const res = await fetch(`${proxy}/__bili/plugin/tool`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: child, tool: 'compress', args: { content: repairContent(entries) } }),
  })
  const out = await res.json().catch(() => ({}))
  return { status: res.status, outcome: out.outcome, blocksCreated: out.blocksCreated, result: String(out.result ?? out.error ?? '') }
}

