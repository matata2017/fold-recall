/**
 * journal.mjs — 会话事件记录 + 压缩后的续接快照（全程不调用模型）。
 *
 * 每轮结束（DSH agent/turn-stopping）记一条：用户这轮的请求、报错、git 状态（改了哪些文件、
 * 这轮之间的新提交、改过又还原的文件）、回复里提到的下一步/待办、用户交代"之后再做"的事。
 * 摘要是模型写的，可能漏掉"哪个文件改到一半""哪个改动被撤回了""答应过之后做什么"；
 * 这些事实从 git 和消息里直接取，压缩后注入一段 ≤1500 字的快照，让模型接着做。
 *
 * 什么时候注入：billion-context 新建了块、且块盖住了最近一轮的消息（说明刚做的事被折进了摘要）。
 * fold-recall 自己的遗忘只折很旧的块，不会触发。每次压缩只注入一次。
 * FOLD_RECALL_JOURNAL=off 关闭（不记录、不注入）。
 */
import { execFileSync } from 'node:child_process'
import * as S from './store.mjs'
import * as B from './bili.mjs'
import { redact, oneLine } from './decide.mjs'

export const SNAPSHOT_MAX = 1500                 // 和回忆共用钩子的 2500 字上限
export const enabled = () => process.env.FOLD_RECALL_JOURNAL !== 'off'

// ---------------------------------------------------------------- git（只读）
const git = (cwd, args) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}
/** { root, head, dirty: {文件: '+a −d' | '新文件'} }；不是 git 仓库返回 null */
export function gitState(cwd) {
  if (!cwd) return null
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  if (!root) return null
  const head = git(root, ['rev-parse', '--short', 'HEAD'])
  const dirty = {}
  for (const l of (git(root, ['-c', 'core.quotepath=off', 'diff', '--numstat', 'HEAD']) ?? '').split('\n')) {
    const m = /^(\S+)\t(\S+)\t(.+)$/.exec(l)
    if (m) dirty[m[3]] = m[1] === '-' ? '二进制' : `+${m[1]} −${m[2]}`
  }
  for (const f of (git(root, ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean).slice(0, 30)) dirty[f] = '新文件'
  return { root: S.normCwd(root), head, dirty }
}

// ---------------------------------------------------------------- 待办（按句式取，不判断；回复里问用户的话也算：等用户拍板）
const NEXT = /下一步|接下来|待办|还没|尚未|未完成|稍后|之后再|回头|还需要|还剩|待确认|要不要|是否需要|需要你|请你|TODO|next step/i
const USER_LATER = /先不|稍后|回头|之后再|以后再|往后放|放后面|待会|别忘|记得|记一下|先做.{0,20}再/
const sentences = (s) => String(s ?? '').split(/(?<=[。！？!?；\n])/).map((x) => oneLine(x).replace(/^[-*>#\d.、\s]+/, '')).filter((x) => x.length >= 4)

export function todosOf(reply, user) {
  const out = sentences(reply).filter((x) => NEXT.test(x) || /[？?]$/.test(x)).slice(-3).map((x) => x.slice(0, 120))
  const asked = USER_LATER.test(user ?? '') ? [`（用户交代）${oneLine(user).slice(0, 120)}`] : []
  return [...asked, ...out]
}

// ---------------------------------------------------------------- 每轮结束：记一条
export function recordTurn(db, bdb, { sessionId, turn, cwd, lastReply }) {
  if (!enabled()) return null
  const prev = S.journalFor(db, sessionId, 1)[0]
  const t = B.recentTurns(bdb, sessionId, 1)[0]
  const g = gitState(cwd)
  const rec = {
    cwd: S.normCwd(cwd), user: redact(t?.user ?? ''), tools: t?.tools ?? {},
    errors: (t?.errorTexts ?? []).slice(-3).map(redact),
    git: g, commits: [], reverted: [],
  }
  const reply = lastReply ?? t?.lastReply ?? ''
  rec.todos = todosOf(redact(reply), rec.user)
  if (g && prev?.git?.root === g.root) {
    let committed = new Set()
    if (prev.git.head && g.head && prev.git.head !== g.head) {
      rec.commits = (git(g.root, ['log', '--format=%h %s', `${prev.git.head}..${g.head}`]) ?? '').split('\n').filter(Boolean).slice(0, 10).map((x) => x.slice(0, 120))
      committed = new Set((git(g.root, ['-c', 'core.quotepath=off', 'diff', '--name-only', prev.git.head, g.head]) ?? '').split('\n').filter(Boolean))
    }
    // 上一轮还是改动状态、现在和 HEAD 一样、中间也没提交过它 → 改过又还原了
    rec.reverted = Object.keys(prev.git.dirty ?? {}).filter((f) => !(f in g.dirty) && !committed.has(f)).slice(0, 10)
  }
  S.addJournal(db, sessionId, turn, B.clockOf(bdb, sessionId), rec)
  return rec
}

// ---------------------------------------------------------------- 压缩后：续接快照
/** 有没有刚发生的压缩（新块盖住了最近一轮）。第一次调用只记下时刻，不算 */
export function freshCompaction(db, bdb, sessionId, { dryRun = false } = {}) {
  if (!enabled()) return null
  const since = S.getKv(db, sessionId, 'snapshot_check')
  const nowTs = Date.now()
  if (!dryRun) S.setKv(db, sessionId, 'snapshot_check', nowTs)
  if (since == null) return null
  // 最近一轮从哪条消息开始；还没有事件记录（第一轮很长、或轮次被打断没走到轮末）时，任何新块都算
  const j = S.journalFor(db, sessionId, 2)
  const lastTurnStart = j.length >= 2 ? j[0].end_ref : 0
  const fresh = B.blocksSince(bdb, sessionId, Number(since)).filter((b) => b.end_ref > lastTurnStart)
  return fresh.length ? fresh : null
}

const uniq = (xs) => [...new Set(xs)]
/**
 * 事件记录 + 还没记进去的轮次：正在进行的这一轮（压缩常发生在长任务中间）、被打断没走到轮末的轮次，
 * 都从 billion-context 的消息里补（请求、报错、回复里的待办；没有 git 历史，只看当前 git 状态）。
 */
function withLiveTurns(j, bdb, sessionId) {
  if (!bdb) return j
  const seen = new Set(j.map((r) => oneLine(r.user).slice(0, 100)))
  const live = B.recentTurns(bdb, sessionId, 5).filter((t) => t.user && !seen.has(oneLine(redact(t.user)).slice(0, 100)))
  return [...j, ...live.map((t) => {
    const user = redact(t.user)
    return { turn: '当前', user, errors: (t.errorTexts ?? []).slice(-3).map(redact), todos: todosOf(redact(t.lastReply), user) }
  })]
}

export function snapshotText(db, sessionId, cwd, blocks = [], bdb = null) {
  const j = withLiveTurns(S.journalFor(db, sessionId, 30), bdb, sessionId)
  if (!j.length) return ''
  const g = gitState(cwd ?? j.findLast((r) => r.cwd)?.cwd)
  const L = ['[续接 · fold-recall] 上下文刚被压缩' + (blocks.length ? `（新摘要 ${blocks.map((b) => b.block_id).join('、')}）` : '') + '。下面是压缩前的工作状态，直接取自 git 和对话记录，未经模型改写；和摘要不一致时以这里为准：']
  const reqs = j.filter((r) => r.user).slice(-5)
  if (reqs.length) L.push('最近的请求（旧→新）：', ...reqs.map((r) => `- ${r.turn === '当前' ? '' : '第 ' + r.turn + ' 轮：'}${oneLine(r.user).slice(0, 100)}`))
  if (g && Object.keys(g.dirty).length) {
    const fs = Object.entries(g.dirty)
    L.push(`未提交的改动（${g.root.split('/').pop()}，HEAD ${g.head}）：` + fs.slice(0, 10).map(([f, d]) => `${f} ${d}`).join('、') + (fs.length > 10 ? ` 等 ${fs.length} 个` : ''))
  } else if (g) L.push(`工作区干净（${g.root.split('/').pop()}，HEAD ${g.head}）`)
  const commits = uniq(j.flatMap((r) => r.commits ?? []))
  if (commits.length) L.push('本会话的提交：' + commits.slice(-6).join('；'))
  const reverted = uniq(j.flatMap((r) => (r.reverted ?? []).map((f) => `${f}（第 ${r.turn} 轮前后）`)))
  if (reverted.length) L.push('改过又还原的文件：' + reverted.slice(-5).join('、'))
  const errs = j.slice(-3).flatMap((r) => r.errors ?? [])
  if (errs.length) L.push('最近的报错：', ...errs.slice(-3).map((e) => `- ${e}`))
  const todos = uniq(j.slice(-8).flatMap((r) => r.todos ?? []))
  if (todos.length) L.push('提到过的下一步 / 待办（可能已完成，先核对）：', ...todos.slice(-6).map((x) => `- ${x}`))
  let out = L.join('\n')
  if (out.length > SNAPSHOT_MAX) out = out.slice(0, SNAPSHOT_MAX - 1) + '…'
  return out
}

/** 钩子每一步都调：刚压缩过就返回快照文本，否则空 */
export function continuation(db, bdb, sessionId, cwd, opts = {}) {
  const fresh = freshCompaction(db, bdb, sessionId, opts)
  return fresh ? snapshotText(db, sessionId, cwd, fresh, bdb) : ''
}
