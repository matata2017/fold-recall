#!/usr/bin/env node
/**
 * fold-recall — 给"一直跑、不开新会话"的智能体加上像人一样的长期记忆（基于 billion-context 的折叠块）。
 *
 *   fold-recall hook                         作为钩子运行（自动识别 DSH agent/pre-step 与 Claude Code UserPromptSubmit）
 *   fold-recall consolidate <session> [--limit N]   整理记忆：类型、重要性、前后关系（钩子会在后台自动跑）
 *   fold-recall recall <session> "<消息>"     试运行：这条消息会找回什么、会不会提示压缩/遗忘（不写任何记录）
 *   fold-recall report <session>             记忆概况：强度分布、钉住的、将被遗忘的、最近的判断
 *   fold-recall repair <session> [--apply]    修复会话继承：把父会话已有的摘要套回子会话（默认只看计划）
 *   fold-recall label <session> <turn> <none|tail|older|unknown> [备注]
 *   fold-recall supersede <session> <bN> [原因] / unsupersede <session> <bN> / superseded   作废被推翻的记忆块
 *   fold-recall snapshot <session> [--log]    续接快照：压缩后会注入什么；--log 列出逐轮事件记录
 *   fold-recall index [<session>]           原文三字索引：补全（钩子每次只补一点，后台整理时补全）
 *   fold-recall doctor                       检查环境
 */
import '../lib/quiet.mjs'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as S from '../lib/store.mjs'
import * as B from '../lib/bili.mjs'
import * as D from '../lib/decide.mjs'
import * as M from '../lib/memory.mjs'
import * as E from '../lib/engine.mjs'
import * as R from '../lib/repair.mjs'
import * as RP from '../lib/replay.mjs'
import * as J from '../lib/journal.mjs'
import * as RI from '../lib/rawindex.mjs'

const SELF = fileURLToPath(import.meta.url)
const LOCK = join(S.HOME, 'consolidate.lock')

// DSH 把同一工作区的会话放在同一目录下：~/.dsh/sessions/<工作区>/<会话>
function dshPeers(sessionId) {
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) return []
  for (const dir of readdirSync(root)) {
    try { const ids = readdirSync(join(root, dir)); if (ids.includes(sessionId)) return ids } catch {}
  }
  return []
}
// 委派出去的子会话（DSH subagent / teammate）默认不注入回忆：
// 子智能体常被要求独立判断（例如先不看主会话的结论），把同项目的旧记忆塞给它会造成锚定。
// 判据：DSH 会话文件头 origin === 'subagent' 或 delegationDepth > 0；钩子数据里的 agent_type 若像子代理也算。
// FOLD_RECALL_SUBAGENTS=on 可恢复对子会话的处理。
function dshSessionHeader(sessionId) {
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) return null
  const bare = sessionId.replace(/^session-/, '')
  const names = [...new Set([sessionId, bare, 'session-' + bare])]            // 子会话目录名可能不带 session- 前缀
  for (const dir of readdirSync(root)) {
    const f = names.map((n) => join(root, dir, n, 'session.v4.jsonl.zstd')).find((x) => existsSync(x))
    if (!f) continue
    try {
      const zlib = process.getBuiltinModule('node:zlib')
      if (typeof zlib.zstdDecompressSync !== 'function') return null
      const buf = readFileSync(f)
      const next = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 4)       // 只解第一帧，文件头在最前面
      const text = zlib.zstdDecompressSync(next > 0 ? buf.subarray(0, next) : buf).toString('utf8')
      return JSON.parse(text.split('\n', 1)[0])
    } catch { return null }
  }
  return null
}
function isDelegated(p, sessionId) {
  if (process.env.FOLD_RECALL_SUBAGENTS === 'on') return false
  if (/sub|delegat|teammate|child/i.test(String(p.agent_type ?? ''))) return true
  const h = dshSessionHeader(sessionId)
  return !!h && (h.origin === 'subagent' || Number(h.delegationDepth) > 0)
}

function peersOf(db, sessionId) {
  return [...new Set([sessionId, ...S.projectPeers(db, sessionId), ...dshPeers(sessionId)])]
}

function lockFresh() {
  try { return Date.now() - statSync(LOCK).mtimeMs < 10 * 60 * 1000 } catch { return false }
}
function spawnConsolidate(sessionId) {
  if (lockFresh()) return
  try {
    spawn(process.execPath, [SELF, 'consolidate', sessionId, '--limit', '40', '--quiet'],
      { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref()
  } catch {}
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  let data = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) data += chunk
  return data
}

// ---------------------------------------------------------------- 钩子
async function hook() {
  let p
  try { p = JSON.parse((await readStdin()) || 'null') } catch { return }
  if (!p) return
  const ev = p.hook_event_name
  const prompt = String(p.prompt ?? '').trim()
  const sessionId = String(p.session_id ?? '')
  if (!sessionId) return
  if (/^\[dsh-mnemon:/.test(prompt)) return                                   // 记忆插件的内部委派
  if (isDelegated(p, sessionId)) {                                            // 子会话：不回忆、不记录（防锚定）
    if (process.env.FOLD_RECALL_DEBUG) process.stderr.write(`fold-recall: 跳过子会话 ${sessionId}\n`)
    return
  }
  let host, turn
  if (ev === 'agent/pre-step' || ev === 'agent/turn-stopping') { host = 'dsh'; turn = Number(String(p.turn_id ?? '').split('#').pop()) }
  else if (ev === 'UserPromptSubmit') { host = 'claude-code'; turn = `t${Date.now()}` }
  else return

  const db = S.openStore()
  S.rememberSession(db, sessionId, p.cwd, host)
  const bdb = B.openBili()
  if (!bdb) return
  // 每轮结束：记一条事件（请求、报错、git 改动/提交/撤回、待办），不输出
  if (ev === 'agent/turn-stopping') return void J.recordTurn(db, bdb, { sessionId, turn, cwd: p.cwd, lastReply: p.last_assistant_message })
  // 每一步：刚被压缩过就先注入续接快照（压缩可能发生在一轮中间）
  const parts = [J.continuation(db, bdb, sessionId, p.cwd)]
  // 每轮第一步：回忆 / 遗忘 / 压缩时机（同一轮只处理一次）
  if (prompt && S.firstSeen(db, sessionId, turn)) {
    const { context, decision } = await E.onPrompt(db, bdb, {
      sessionId, turn, prompt, peers: peersOf(db, sessionId),
      timeoutMs: Number(process.env.FOLD_RECALL_TIMEOUT_MS || 6000),
    })
    if (decision.unjudged > 0 && D.apiKey()) spawnConsolidate(sessionId)
    parts.push(context)
  }
  const context = parts.filter(Boolean).join('\n\n')
  if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: context } }) + '\n')
}

// ---------------------------------------------------------------- 命令行
const args = process.argv.slice(2)
const flag = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const VALUED = new Set(['--limit', '--turn'])
const pos = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1]))

function resolveSession(bdb, prefix) {
  const r = bdb.prepare("select session_id from sessions where session_id like ? and session_id not like '%|%' order by updated_at desc").get(prefix + '%')
  if (!r) { console.error('bili 里找不到会话：' + prefix); process.exit(1) }
  return r.session_id
}

async function cmdConsolidate() {
  const quiet = args.includes('--quiet')
  const db = S.openStore(), bdb = B.openBili()
  if (!bdb) return console.error('找不到 billion-context 的库：' + B.BILI_DB)
  const sid = resolveSession(bdb, pos[1])
  if (lockFresh() && !args.includes('--force')) return quiet || console.error('已有整理在运行（' + LOCK + '）')
  writeFileSync(LOCK, String(process.pid))
  try {
    const r = await E.consolidate(db, bdb, peersOf(db, sid), {
      limit: Number(flag('--limit', 40)), log: quiet ? () => {} : (s) => console.log(s),
    })
    if (!quiet) console.log(`整理完成 ${r.done}，失败 ${r.failed}，剩余未整理 ${r.left}`)
  } finally { try { unlinkSync(LOCK) } catch {} }
}

/**
 * 回忆评测：fold-recall eval <题目.json>
 * 题目：[{ "session": "会话前缀", "prompt": "消息", "expect": ["b91", "其他会话前缀#b3"] }]，expect 为空 = 不该触发回忆。
 * 每题试运行（不写任何记录），统计：该找回的找回了没（命中）、正确答案进没进候选、不该触发的有没有误触发。
 */
async function cmdEval() {
  const items = JSON.parse(readFileSync(pos[1], 'utf8'))
  const db = S.openStore(), bdb = B.openBili()
  // 期望的块按"内容"比：复制/恢复出的会话继承了同样的块（不同会话、同样内容），找回哪一份都算对
  let expectKeys = new Set()
  const want = (item, b) => expectKeys.has(M.contentKey(b))
  const rows = []
  for (const item of items) {
    const sid = resolveSession(bdb, item.session)
    const { decision, mem } = await E.onPrompt(db, bdb, { sessionId: sid, turn: 99, prompt: item.prompt, peers: peersOf(db, sid), dryRun: true, timeoutMs: 20000 })
    const byKey = new Map(mem.blocks.map((b) => [b.key, b]))
    expectKeys = new Set(mem.blocks.filter((b) => (item.expect ?? []).some((e) => e.includes('#')
      ? b.session_id.startsWith(e.split('#')[0]) && b.block_id === e.split('#')[1]
      : b.session_id.startsWith(item.session) && b.block_id === e)).map(M.contentKey))
    const recalled = (decision.recalled ?? []).map((k) => byKey.get(k)).filter(Boolean)
    const cands = M.candidates(mem, D.MAX_OPTIONS, { current: sid })
    const positive = (item.expect ?? []).length > 0
    const row = {
      prompt: item.prompt, positive, error: decision.error,
      hit: positive ? recalled.some((b) => want(item, b)) : recalled.length === 0,
      inCands: positive ? cands.some((b) => want(item, b)) : null,
      got: recalled.map((b) => b.block_id).join('+') || '-',
      p: decision.recall ? `${(+decision.recall.p).toFixed(2)}/${(+decision.recall.pNone).toFixed(2)}` : '-',
      ms: decision.latency_ms ?? 0,
    }
    rows.push(row)
    console.log(`${row.hit ? '✓' : '✗'} ${positive ? '问旧事' : '不该回忆'}  找回 ${row.got.padEnd(8)} 期望 ${(item.expect ?? []).join('|') || '无'}  ${positive ? (row.inCands ? '在候选里' : '不在候选里') : ''}  p/none ${row.p}  ${row.error ?? ''} ${item.prompt.slice(0, 40)}`)
  }
  const pos_ = rows.filter((r) => r.positive), neg = rows.filter((r) => !r.positive)
  const pct = (a, b) => (b ? `${a}/${b}（${Math.round((a / b) * 100)}%）` : '-')
  console.log(`\n问旧事：找回正确 ${pct(pos_.filter((r) => r.hit).length, pos_.length)}，正确答案进了候选 ${pct(pos_.filter((r) => r.inCands).length, pos_.length)}，什么也没找回 ${pos_.filter((r) => r.got === '-').length}，找错 ${pos_.filter((r) => r.got !== '-' && !r.hit).length}`)
  console.log(`不该回忆：误触发 ${pct(neg.filter((r) => !r.hit).length, neg.length)}`)
  console.log(`失败 ${rows.filter((r) => r.error).length}，决策延迟中位 ${rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)]}ms`)
}

/** 遗忘的事后检验：fold-recall replay <会话>（两种策略对比；不调接口、不写任何东西） */
function cmdReplay() {
  const db = S.openStore(), bdb = B.openBili()
  const sid = resolveSession(bdb, pos[1])
  const mem = B.loadMemory(bdb, [sid])
  const meta = S.metaMap(db)
  const messages = RP.loadMessages(bdb, sid)
  console.log(`会话 ${sid}：消息 ${messages.length} 条（其中用户 ${messages.filter((m) => m.user).length} 条），记忆块 ${mem.blocks.filter((b) => b.session_id === sid).length} 个\n`)
  let printedBase = false
  for (const [name, p] of Object.entries(RP.POLICIES)) {
    const r = RP.replay(mem, meta, messages, sid, p.fn)
    if (!printedBase) {
      printedBase = true
      const bl = r.baseline, hit = (t) => { const l = bl.filter((x) => !t || x.block.type === t); return `${l.filter((x) => x.reusedAt != null).length}/${l.length}` }
      console.log(`基线（检测器灵敏度）：所有块折叠之后又被提到 ${hit()}；按类型 episode ${hit('episode')} · knowledge ${hit('knowledge')} · noise ${hit('noise')} · preference ${hit('preference')}
`)
    }
    const f = r.forgotten, reused = f.filter((x) => x.reusedAt != null)
    const byType = (list) => ['episode', 'noise', 'knowledge'].map((t) => `${t} ${list.filter((x) => x.block.type === t).length}`).join(' / ')
    const chars = f.reduce((s, x) => s + x.block.summary.length, 0)
    console.log(`== ${p.label}（${name}）`)
    console.log(`  遗忘 ${f.length} 块（${byType(f)}），共 ${r.passes} 次，移出摘要约 ${Math.round(chars / 1000)}K 字`)
    console.log(`  之后又被用到 ${reused.length} 块（${byType(reused)}）；其中 500 条消息内就用到 ${reused.filter((x) => x.reusedAt - x.at <= 500).length} 块`)
    for (const x of reused.slice(0, 15)) {
      console.log(`    ${x.block.block_id.padEnd(4)} ${String(x.block.type).padEnd(9)} 遗忘于 m${x.at} → m${x.reusedAt}（隔 ${x.reusedAt - x.at} 条，${x.reusedBy === 'user' ? '你提到' : '模型提到'}）「${x.block.topic.slice(0, 36)}」`)
    }
    console.log('')
  }
}

async function cmdRecall() {
  const db = S.openStore(), bdb = B.openBili()
  const sid = resolveSession(bdb, pos[1])
  const prompt = pos.slice(2).join(' ')
  const { context, decision, mem } = await E.onPrompt(db, bdb, { sessionId: sid, turn: Number(flag('--turn', 99)), prompt, peers: peersOf(db, sid), dryRun: true, timeoutMs: 15000 })
  const top = M.candidates(mem, 8, { current: sid })
  console.log(`记忆块 ${mem.blocks.length}，候选 ${decision.candidates}，提起 ${decision.mentioned.length}，用量 ${decision.tokens}/${decision.window}，${decision.latency_ms ?? '-'}ms`)
  for (const b of top) console.log(`  ${b.block_id.padEnd(5)} rel=${b.rel.toFixed(2)} w=${b.w.toFixed(3)} ${b.pinned ? '📌' : '  '} ${b.type ?? '?'}  ${b.session_id === sid ? '' : '[' + b.session_id.slice(0, 14) + '] '}${b.topic.slice(0, 50)}`)
  console.log('判断：', JSON.stringify({ recall: decision.recall, latest: decision.latest, recalled: decision.recalled, timing: decision.timing && { tier: decision.timing.tier, pNew: +decision.timing.pNew.toFixed(2), s2: +decision.timing.s2.toFixed(2) }, forget: decision.forget, error: decision.error }))
  console.log('\n--- 将注入 ---\n' + (context || '（无）'))
}

function cmdReport() {
  const db = S.openStore(), bdb = B.openBili()
  const sid = resolveSession(bdb, pos[1])
  const mem = E.loadAll(db, bdb, peersOf(db, sid))
  const bs = mem.blocks
  const cnt = (f) => bs.filter(f).length
  console.log(`会话 ${sid}\n同项目会话 ${mem.clock.size} 个，记忆块 ${bs.length}（本会话 ${cnt((b) => b.session_id === sid)}，其中在上下文里 ${cnt((b) => b.session_id === sid && b.active)}）`)
  console.log(`已整理 ${cnt((b) => b.type)}：` + D.TYPES.map((t) => `${t} ${cnt((b) => b.type === t)}`).join('，') + `；钉住 ${cnt((b) => b.pinned)}`)
  const ws = bs.map((b) => b.w).sort((a, b) => a - b)
  const q = (x) => ws[Math.floor(x * (ws.length - 1))]?.toFixed(3)
  console.log(`强度 分位 10/50/90%：${q(0.1)} / ${q(0.5)} / ${q(0.9)}；遗忘线 ${M.FORGET_W.toFixed(3)}；保持度低于遗忘线 ${cnt((b) => b.keep < M.FORGET_W)}`)
  console.log('\n📌 钉住（永不遗忘）：')
  for (const b of bs.filter((b) => b.pinned).sort((a, b) => b.w - a.w).slice(0, 20)) console.log(`  ${b.block_id.padEnd(5)} ${b.type.padEnd(10)} key=${(b.pKey ?? 0).toFixed(2)} w=${b.w.toFixed(3)}  ${b.topic.slice(0, 50)}`)
  console.log('\n🔥 最常被提起/找回：')
  for (const b of [...bs].sort((a, b) => (b.mentions + b.recalls) - (a.mentions + a.recalls)).slice(0, 8).filter((b) => b.mentions + b.recalls))
    console.log(`  ${b.block_id.padEnd(5)} 提起 ${b.mentions} 找回 ${b.recalls} w=${b.w.toFixed(3)}  ${b.topic.slice(0, 50)}`)
  const runs = M.forgetRuns(mem, sid, { minBlocks: 1, maxBlocks: 999 })
  console.log(`\n💤 下次将遗忘（本会话）：${runs.flat().length} 块`)
  for (const r of runs) console.log('  ' + r.map((b) => `${b.block_id}「${b.topic.slice(0, 16)}」`).join('、'))
  const rows = db.prepare('select ts, turn, json from decisions where session_id=? order by ts desc limit 10').all(sid)
  if (rows.length) console.log('\n最近的判断：')
  for (const r of rows.reverse()) {
    const d = JSON.parse(r.json)
    console.log(`  ${new Date(r.ts).toISOString().slice(5, 16)} T${r.turn} 候选${d.candidates} ${d.recalled ? '找回 ' + d.recalled.map((k) => k.split('#')[1]).join('+') : ''} ${d.timing?.tier ? '时机:' + d.timing.tier : ''} ${d.forget ? '遗忘 ' + (d.forget.blocks ?? d.forget).length + ' 块' + (d.forget.outcome ? '(' + d.forget.outcome + ')' : '') : ''} ${d.error ? '错误:' + d.error : ''} ${d.total_ms}ms`)
  }
}

async function cmdRepair() {
  const bdb = B.openBili()
  if (!bdb) return console.error('找不到 billion-context 的库：' + B.BILI_DB)
  const sid = resolveSession(bdb, pos[1])
  const plan = R.repairPlan(bdb, sid)
  if (!plan.parent) return console.log(`${sid} 没有记录父会话（不是恢复/复制出来的会话），无需修复`)
  console.log(`子会话 ${sid}\n父会话 ${plan.parent}\n可套回 ${plan.entries.length} 段：`)
  for (const e of plan.entries) console.log(`  m${e.a}–m${e.z}（${e.refs} 条）← ${e.ids}  ${e.topic.slice(0, 50)}`)
  for (const k of plan.skipped) console.log(`  跳过 ${k.ids}：${k.why}`)
  if (!plan.entries.length) return
  if (!args.includes('--apply')) return console.log('\n这是计划。确认后加 --apply 执行（经 billion-context 的 compress，原文不丢，可 decompress）')
  const r = await R.applyRepair(plan.entries, sid)
  console.log(`\nHTTP ${r.status} ${r.outcome ?? ''}，新建 ${r.blocksCreated ?? 0} 块\n${r.result.slice(0, 1200)}`)
}

function cmdLabel() {
  const [, sid, turn, need, ...note] = pos
  if (!['none', 'tail', 'older', 'unknown'].includes(need)) return console.error('用法：label <session> <turn> <none|tail|older|unknown> [备注]')
  S.openStore().prepare('insert or replace into labels values (?,?,?,?,?)').run(sid, String(turn), need, note.join(' '), Date.now())
  console.log('已记录')
}

/**
 * 作废：fold-recall supersede <会话> <块> [原因]   撤销：fold-recall unsupersede <会话> <块>   列出：fold-recall superseded
 * 内容已被推翻的记忆块（例如旧的设定、已更正的结论）：不再被找回、不再被提起加强、追"最新进展"时跳过、可以被移出上下文。
 * 按内容作废：复制/恢复出的同内容副本一起作废。原文不删，decompress 仍可查看。
 */
function findBlock(db, bdb) {
  const sid = resolveSession(bdb, pos[1])
  const id = String(pos[2] ?? '')
  if (!/^b\d+$/.test(id)) { console.error('块写成 bN，例如 b3'); process.exit(1) }
  const mem = E.loadAll(db, bdb, peersOf(db, sid))
  const b = mem.blocks.find((x) => x.session_id === sid && x.block_id === id)
  if (!b) { console.error(`${sid} 里没有块 ${id}`); process.exit(1) }
  return b
}
function cmdSupersede() {
  const db = S.openStore(), bdb = B.openBili()
  if (!bdb) return console.error('找不到 billion-context 的库：' + B.BILI_DB)
  const b = findBlock(db, bdb)
  const reason = pos.slice(3).join(' ')
  S.supersede(db, M.contentKey(b), b.key, reason)
  console.log(`已作废 ${b.key.split('#')[0].slice(0, 16)}… ${b.block_id}「${b.topic.slice(0, 40)}」${reason ? '：' + reason : ''}`)
}
function cmdUnsupersede() {
  const db = S.openStore(), bdb = B.openBili()
  if (!bdb) return console.error('找不到 billion-context 的库：' + B.BILI_DB)
  const b = findBlock(db, bdb)
  console.log(S.unsupersede(db, M.contentKey(b)) ? `已撤销作废 ${b.block_id}「${b.topic.slice(0, 40)}」` : `${b.block_id} 本来就没有作废`)
}
function cmdSuperseded() {
  const rows = S.supersededList(S.openStore())
  if (!rows.length) return console.log('没有作废的记忆块')
  for (const r of rows) console.log(`${new Date(r.ts).toISOString().slice(0, 10)}  ${r.key}  ${r.reason}`)
}

// 续接快照：压缩后会注入什么（只看，不改"上次检查"的时刻）；--log 列出逐轮事件记录
function cmdSnapshot() {
  const db = S.openStore(), bdb = B.openBili()
  if (!bdb) return console.error('找不到 billion-context 的库：' + B.BILI_DB)
  const sid = resolveSession(bdb, pos[1] ?? '')
  const j = S.journalFor(db, sid, 30)
  if (!j.length) return console.log(`${sid} 还没有事件记录（每轮结束时由 agent/turn-stopping 钩子记录）`)
  if (args.includes('--log')) for (const r of j) console.log(`第 ${r.turn} 轮 ${new Date(r.ts).toISOString().slice(5, 16)} 消息≤${r.end_ref}  ${D.oneLine(r.user).slice(0, 60)}` +
    `${r.commits?.length ? `\n  提交：${r.commits.join('；')}` : ''}${r.reverted?.length ? `\n  还原：${r.reverted.join('、')}` : ''}` +
    `${r.errors?.length ? `\n  报错：${r.errors.length} 条` : ''}${r.todos?.length ? `\n  待办：${r.todos.join(' / ')}` : ''}`)
  console.log((args.includes('--log') ? '\n' : '') + J.snapshotText(db, sid, null))
}

// 原文索引：补全某会话所在项目（不给会话则全部会话）的原文三字索引
function cmdIndex() {
  const db = S.openStore(), bdb = B.openBili()
  if (!bdb) return console.error('找不到 billion-context 的库：' + B.BILI_DB)
  const sids = pos[1] ? B.biliSessions(bdb, peersOf(db, resolveSession(bdb, pos[1]))).map((s) => s.session_id)
    : bdb.prepare('select session_id from sessions').all().map((r) => r.session_id)
  const t0 = Date.now()
  const n = RI.indexSessions(db, bdb, sids)
  const total = db.prepare('select count(*) n from raw_map').get().n
  console.log(`新索引 ${n} 条（${sids.length} 个会话，${((Date.now() - t0) / 1000).toFixed(1)} 秒）；累计 ${total} 条；状态库 ${(statSync(join(S.HOME, 'state.db')).size / 1e6).toFixed(1)} MB`)
}

async function cmdDoctor() {
  const [maj, min] = process.versions.node.split('.').map(Number)
  console.log(`node ${process.versions.node} ${maj > 22 || (maj === 22 && min >= 5) ? 'OK' : '需要 ≥ 22.5（node:sqlite）'}`)
  console.log(`billion-context 库 ${B.BILI_DB} ${existsSync(B.BILI_DB) ? 'OK' : '不存在'}`)
  console.log(`状态库 ${join(S.HOME, 'state.db')}`)
  console.log(`决策模型 ${D.model()} @ ${D.endpoint()}，密钥 ${D.apiKey() ? '已配置' : '未配置（设置 FOLD_RECALL_API_KEY 或 BAMBOO_API_KEY）'}`)
  if (D.apiKey()) {
    try { const r = await D.ask('ping', { ok: { type: 'choice', instructions: 'Is this a test?', criteria: ['yes', 'no'] } }, { timeoutMs: 15000 }); console.log(`接口 OK ${r.latencyMs}ms`) }
    catch (e) { console.log('接口失败：' + e.message) }
  }
}

const cmds = { hook, consolidate: cmdConsolidate, recall: cmdRecall, eval: cmdEval, replay: cmdReplay, report: cmdReport, repair: cmdRepair, label: cmdLabel, doctor: cmdDoctor,
  supersede: cmdSupersede, unsupersede: cmdUnsupersede, superseded: cmdSuperseded, snapshot: cmdSnapshot, index: cmdIndex }
const run = cmds[args[0]]
if (!run) { console.log(readFileHead()); process.exit(args[0] ? 1 : 0) }
// 钩子里任何异常都不能打断宿主
Promise.resolve(run()).catch((e) => { if (args[0] !== 'hook' || process.env.FOLD_RECALL_DEBUG) { console.error(e); process.exitCode = 1 } })

function readFileHead() {
  return `fold-recall <hook|consolidate|recall|report|snapshot|index|repair|label|supersede|unsupersede|superseded|doctor>  （详见 README）`
}
