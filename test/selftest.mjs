// selftest.mjs — 不需要密钥、不碰真实数据：造一个假的 billion-context 库 + 本地假决策接口，跑通整条链路
import '../lib/quiet.mjs'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'fold-recall-test-'))
process.env.FOLD_RECALL_HOME = join(dir, 'home')
process.env.BILI_INDEX_DB = join(dir, 'index.db')
process.env.FOLD_RECALL_API_KEY = 'test'

// ---------------------------------------------------------------- 假 billion-context 库
const SID = 'session-test', OTHER = 'session-older'
const bdbW = new DatabaseSync(process.env.BILI_INDEX_DB)
bdbW.exec(`
create table sessions (session_id text, created_at integer, updated_at integer, stats_json text, metadata_json text);
create table refs (session_id text, ord integer, raw_id text, ref text, ref_num integer);
create table blocks (block_id text, session_id text, ord integer, start_ref integer, end_ref integer, tier integer, active integer, created_at integer, payload_json text);
create table messages (session_id text, seq integer, msg_id text, ref text, ref_num integer, role text, kind text, content_hash text, identity text, retired_at integer);
create table content (hash text, byte_len integer, refcount integer, algo text, bytes blob);`)
const T0 = Date.UTC(2026, 9, 1)
bdbW.prepare('insert into sessions values (?,?,?,?,?)').run(OTHER, T0, T0, '{}', '{}')
bdbW.prepare('insert into sessions values (?,?,?,?,?)').run(SID, T0 + 1e6, T0 + 2e6, JSON.stringify({ contextTokens: 120000 }), JSON.stringify({ effectiveContextLimit: 1000000 }))
for (let i = 1; i <= 3000; i++) bdbW.prepare('insert into refs values (?,?,?,?,?)').run(SID, i, 'h' + i, 'm' + i, i)
for (let i = 1; i <= 50; i++) bdbW.prepare('insert into refs values (?,?,?,?,?)').run(OTHER, i, 'o' + i, 'm' + i, i)
const blk = bdbW.prepare('insert into blocks values (?,?,?,?,?,?,?,?,?)')
const BLOCKS = [
  // [会话, id, 起, 止, 主题, 摘要]
  [OTHER, 'b1', 1, 40, '用户约定：回复一律用中文，先给结论', '用户要求：以后所有回复都用中文，先给结论再给理由。'],
  [SID, 'b1', 1, 200, '早期排查日志格式', '读了 logger.js，确认日志是 JSON 行格式，无改动。'],
  [SID, 'b2', 201, 400, '部署脚本 deploy.sh 失败排查', 'deploy.sh 在 rsync 一步失败，原因是目标磁盘满；清理后重试成功。'],
  [SID, 'b3', 401, 600, '部署脚本 deploy.sh 最终结果', 'deploy.sh 已修好并推送 v1.2.0，线上验证通过。'],
  [SID, 'b4', 601, 800, '闲聊', '确认收到。'],
  [SID, 'b5', 2900, 2950, '支付回调签名校验', '实现 HMAC 签名校验，测试通过，未提交。'],
]
BLOCKS.forEach(([s, id, a, z, topic, summary], i) => blk.run(id, s, i, a, z, 1, 1, T0 + (s === OTHER ? 0 : 1e6) + i * 1000, JSON.stringify({ topic, summary })))
const msg = bdbW.prepare('insert into messages values (?,?,?,?,?,?,?,?,?,?)'), con = bdbW.prepare('insert into content values (?,?,?,?,?)')
let seq = 0
function put(role, kind, obj) {
  const bytes = Buffer.from(JSON.stringify(obj)), h = createHash('sha1').update(bytes).update(String(seq)).digest('hex')
  con.run(h, bytes.length, 1, 'none', bytes); seq++
  msg.run(SID, seq, 'x' + seq, 'm' + seq, seq, role, kind, h, null, null)
}
put('user', 'text', { text: '把支付回调的签名校验做了' })
put('user', 'text', { text: 'Current runtime context. This snapshot supersedes earlier ones.' })   // 宿主注入，应被跳过
put('assistant', 'tool-call', { toolName: 'edit', text: '{}' })
put('assistant', 'text', { text: '签名校验已实现，测试通过。要提交吗？' })
bdbW.close()

// ---------------------------------------------------------------- 假决策接口：按题目选第一个"像样"的答案
let calls = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d)).on('end', () => {
    calls++
    const { questions, state } = JSON.parse(body)
    const answers = {}
    for (const [id, q] of Object.entries(questions)) {
      const keys = Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria)
      let pick = keys[0]
      if (id === 'recall' || id === 'latest') pick = /deploy/.test(state) ? keys.find((k) => /最终结果/.test(k)) ?? keys.at(-1) : keys.at(-1)
      if (id === 'type') pick = keys.find((k) => (/约定/.test(state) ? /^preference/ : /闲聊/.test(state) ? /^noise/ : /^episode/).test(k))
      if (id === 'importance') pick = keys.find((k) => (/约定/.test(state) ? /^key/ : /^trivial/).test(k))
      if (id === 'relation') pick = keys.find((k) => k.startsWith(/deploy/.test(state) ? 'continue_same' : 'unrelated'))
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === pick ? 0.9 : 0.1 / (keys.length - 1)]))
      answers[id] = { choice: pick, probabilities, confidence: 0.9 }
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ answers }))
  })
})
await new Promise((r) => server.listen(0, r))
process.env.FOLD_RECALL_ENDPOINT = `http://127.0.0.1:${server.address().port}/v1/decisions`

const S = await import('../lib/store.mjs')
const B = await import('../lib/bili.mjs')
const E = await import('../lib/engine.mjs')
const M = await import('../lib/memory.mjs')
const db = S.openStore(), bdb = B.openBili()
const peers = [SID, OTHER]
let ok = 0
const t = async (name, fn) => { await fn(); ok++; console.log('✓ ' + name) }

try {
  await t('只读 bili：块、时钟、用量', () => {
    const mem = B.loadMemory(bdb, peers)
    assert.equal(mem.blocks.length, 6)
    assert.equal(mem.clock.get(SID), 3000)
    assert.deepEqual(B.usage(bdb, SID), { tokens: 120000, window: 1000000 })
  })
  await t('还原最近几轮：跳过宿主注入的"用户"消息', () => {
    const turns = B.recentTurns(bdb, SID, 3)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].user, '把支付回调的签名校验做了')
    assert.match(turns[0].lastReply, /要提交吗/)
  })
  await t('整理：类型、重要性；约定被钉住', async () => {
    const r = await E.consolidate(db, bdb, peers, { concurrency: 2 })
    assert.equal(r.failed, 0)
    const mem = E.loadAll(db, bdb, peers)
    const pref = mem.blocks.find((b) => b.session_id === OTHER)
    assert.equal(pref.type, 'preference'); assert.ok(pref.pinned)
    assert.equal(mem.blocks.find((b) => b.topic === '闲聊').type, 'noise')
  })
  await t('遗忘：本会话很久没用的旧块（不含钉住的、不含最近的）', () => {
    const mem = E.loadAll(db, bdb, peers)
    const runs = M.forgetRuns(mem, SID)
    const ids = runs.flat().map((b) => b.block_id)
    assert.deepEqual(ids, ['b1', 'b2', 'b3', 'b4'])
    assert.ok(!ids.includes('b5'))
  })
  await t('回忆：问"最后结果"→ 找回最终结果那段，并记一次强化', async () => {
    const { context, decision } = await E.onPrompt(db, bdb, { sessionId: SID, turn: 10, prompt: 'deploy.sh 部署脚本最后修好没', peers })
    assert.match(context, /\[回忆 · fold-recall\].*deploy\.sh 最终结果/)
    assert.match(context, /decompress 展开 b3/)                     // 本会话折叠中的块：让模型展开
    assert.deepEqual(decision.recalled, [`${SID}#b3`])
    const mem = E.loadAll(db, bdb, peers)
    const b3 = mem.blocks.find((b) => b.key === `${SID}#b3`)
    assert.equal(b3.recalls, 1)
    assert.ok(b3.w > mem.blocks.find((b) => b.key === `${SID}#b1`).w * 10)   // 刚被找回的远比没用过的牢
  })
  await t('被找回过的块不再提示遗忘；遗忘有冷却', async () => {
    const mem = E.loadAll(db, bdb, peers)
    assert.ok(!M.forgetRuns(mem, SID).flat().some((b) => b.block_id === 'b3'))
    const { decision } = await E.onPrompt(db, bdb, { sessionId: SID, turn: 11, prompt: '写个爬虫抓天气预报', peers })
    assert.equal(decision.forget, undefined)                          // 上一轮已提示过
    assert.equal(decision.timing?.tier, 'switch')                     // 换话题 → 提示压缩
  })
  await t('"继续"这类消息不触发回忆、不调用回忆题', async () => {
    const before = calls
    const { decision } = await E.onPrompt(db, bdb, { sessionId: SID, turn: 20, prompt: '继续', peers, dryRun: true })
    assert.equal(decision.candidates, 0)
    assert.ok(calls - before <= 1)
  })
  await t('决策接口失败：不注入回忆与时机提示，也不阻塞', async () => {
    const saved = process.env.FOLD_RECALL_ENDPOINT
    process.env.FOLD_RECALL_ENDPOINT = 'http://127.0.0.1:9/v1/decisions'          // 没人监听的端口
    try {
      const { context, decision } = await E.onPrompt(db, bdb, { sessionId: SID, turn: 30, prompt: 'deploy.sh 部署脚本最后修好没', peers, dryRun: true, timeoutMs: 1500 })
      assert.ok(decision.error)
      assert.doesNotMatch(context, /回忆|压缩时机/)
    } finally { process.env.FOLD_RECALL_ENDPOINT = saved }
  })
  await t('继承修复：只套回子会话没覆盖的父块，避开已有块，跳过太短的摘要', async () => {
    const R = await import('../lib/repair.mjs')
    const w = new DatabaseSync(process.env.BILI_INDEX_DB)
    const KID = 'session-kid'
    w.prepare('insert into sessions values (?,?,?,?,?)').run(KID, T0 + 3e6, T0 + 3e6, '{}', JSON.stringify({ derivedFrom: SID }))
    for (const i of [1, 2, 3, 5, 6, 8, ...Array.from({ length: 700 }, (_, k) => 201 + k)]) w.prepare('insert into refs values (?,?,?,?,?)').run(KID, i, 'k' + i, 'm' + i, i)
    const long = '要点。'.repeat(120)
    w.prepare('insert into blocks values (?,?,?,?,?,?,?,?,?)').run('b1', KID, 0, 201, 400, 1, 1, T0 + 3e6, JSON.stringify({ topic: '已继承', summary: long }))
    w.prepare('update blocks set payload_json=? where session_id=? and block_id=?').run(JSON.stringify({ topic: '部署脚本 deploy.sh 最终结果', summary: long }), SID, 'b3')
    w.close()
    const plan = R.repairPlan(bdb, KID)
    assert.equal(plan.parent, SID)
    const got = plan.entries.map((e) => `${e.ids}:${e.a}-${e.z}`)
    assert.deepEqual(got, ['b3:401-600'])                        // b2 已被子会话 b1 覆盖；b1、b4 摘要太短被跳过；b5 的范围子会话里没有消息
    assert.ok(plan.skipped.some((s) => s.ids === 'b4'))
    assert.match(R.repairContent(plan.entries), /^m00401–m00600 部署脚本 deploy\.sh 最终结果\n要点/)
  })
  await t('脱敏：密钥样式的串不会发出去', async () => {
    const D = await import('../lib/decide.mjs')
    assert.equal(D.redact('key sk-abcdefghijklmnopqrstuvwxyz ok'), 'key <已脱敏> ok')
  })
  console.log(`\n${ok} 项全部通过（假接口被调用 ${calls} 次）`)
} finally {
  server.close(); db.close(); bdb.close()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
