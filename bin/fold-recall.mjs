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
 *   fold-recall doctor                       检查环境
 */
import '../lib/quiet.mjs'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as S from '../lib/store.mjs'
import * as B from '../lib/bili.mjs'
import * as D from '../lib/decide.mjs'
import * as M from '../lib/memory.mjs'
import * as E from '../lib/engine.mjs'
import * as R from '../lib/repair.mjs'

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
  if (!prompt || !sessionId) return                                           // DSH：只有每轮第一步带用户消息
  if (/^\[dsh-mnemon:/.test(prompt)) return                                   // 记忆插件的内部委派
  let host, turn
  if (ev === 'agent/pre-step') { host = 'dsh'; turn = Number(String(p.turn_id ?? '').split('#').pop()) }
  else if (ev === 'UserPromptSubmit') { host = 'claude-code'; turn = `t${Date.now()}` }
  else return

  const db = S.openStore()
  S.rememberSession(db, sessionId, p.cwd, host)
  if (!S.firstSeen(db, sessionId, turn)) return                              // 同一轮只处理一次
  const bdb = B.openBili()
  if (!bdb) return
  const { context, decision } = await E.onPrompt(db, bdb, {
    sessionId, turn, prompt, peers: peersOf(db, sessionId),
    timeoutMs: Number(process.env.FOLD_RECALL_TIMEOUT_MS || 6000),
  })
  if (decision.unjudged > 0 && D.apiKey()) spawnConsolidate(sessionId)
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

async function cmdRecall() {
  const db = S.openStore(), bdb = B.openBili()
  const sid = resolveSession(bdb, pos[1])
  const prompt = pos.slice(2).join(' ')
  const { context, decision, mem } = await E.onPrompt(db, bdb, { sessionId: sid, turn: Number(flag('--turn', 99)), prompt, peers: peersOf(db, sid), dryRun: true, timeoutMs: 15000 })
  const top = M.candidates(mem, 8)
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
  console.log(`\n💤 下次将提示遗忘（本会话）：${runs.flat().length} 块`)
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

const cmds = { hook, consolidate: cmdConsolidate, recall: cmdRecall, report: cmdReport, repair: cmdRepair, label: cmdLabel, doctor: cmdDoctor }
const run = cmds[args[0]]
if (!run) { console.log(readFileHead()); process.exit(args[0] ? 1 : 0) }
// 钩子里任何异常都不能打断宿主
Promise.resolve(run()).catch((e) => { if (args[0] !== 'hook' || process.env.FOLD_RECALL_DEBUG) { console.error(e); process.exitCode = 1 } })

function readFileHead() {
  return `fold-recall <hook|consolidate|recall|report|repair|label|doctor>  （详见 README）`
}
