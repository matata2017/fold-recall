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
put('tool', 'tool-result', { toolName: 'bash', toolIsError: true, text: 'push 被拒 key=sk-abcdefghijklmnopqrstuvwxyz' })   // bili 用 toolIsError 标报错
put('assistant', 'text', { text: '签名校验已实现，测试通过。要提交吗？' })
bdbW.close()

// ---------------------------------------------------------------- 假决策接口：按题目选第一个"像样"的答案
let calls = 0
const compressed = []                                    // 假的 billion-context 插件接口收到的 compress
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d)).on('end', () => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/__bili/plugin/tool') {
      const j = JSON.parse(body)
      compressed.push(j)
      return res.end(JSON.stringify({ ok: true, tool: j.tool, outcome: 'applied', blocksCreated: 1, result: '[Compressed]' }))
    }
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
process.env.BILI_PROXY = `http://127.0.0.1:${server.address().port}`          // 绝不碰真实的 billion-context

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
    assert.equal(turns[0].errors, 1)
    assert.match(turns[0].errorTexts[0], /^bash：push 被拒/)
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
  await t('保守遗忘：知识、偏好/约定类的块再淡也不忘', () => {
    const key = `${SID}#b2`
    const old = db.prepare('select type from meta where key=?').get(key).type
    db.prepare('update meta set type=? where key=?').run('knowledge', key)
    try {
      const ids = M.forgetRuns(E.loadAll(db, bdb, peers), SID).flat().map((b) => b.block_id)
      assert.deepEqual(ids, ['b1', 'b3', 'b4'])                       // b2 成了知识类：留下
    } finally { db.prepare('update meta set type=? where key=?').run(old, key) }
  })
  await t('这一轮刚提起/找回的块不会被同时遗忘', async () => {
    // 提到 deploy：b2、b3 被提起/找回，剩下的旧块只有 b1、b4，不够 3 块，不遗忘
    const { decision } = await E.onPrompt(db, bdb, { sessionId: SID, turn: 8, prompt: 'deploy.sh 部署脚本最后修好没', peers, dryRun: true })
    assert.equal(decision.forget, undefined)
    assert.equal(compressed.length, 0)
  })
  await t('遗忘在后台执行：经 billion-context 的 compress 折成只列主题的索引；对话里只有回忆的一两行', async () => {
    // 换个不相关的话题：旧块 b1–b4 都淡了，后台折成一个索引块；时机判断只记录、不注入
    const r9 = await E.onPrompt(db, bdb, { sessionId: SID, turn: 9, prompt: '写个爬虫抓一下天气预报', peers })
    assert.equal(r9.context, '')
    assert.equal(compressed.length, 1)
    assert.equal(compressed[0].conversationId, SID)
    assert.match(compressed[0].args.content, /^m00001–m00800 旧工作索引（fold-recall 遗忘，4 段）\n- b1「早期排查日志格式」/)
    assert.equal(r9.decision.forget.outcome, 'applied')
    assert.equal(r9.decision.timing?.tier, 'switch')                  // 换话题：判断照记，但不注入
    // 问起来时照样找回（这里的假 billion-context 不真的折叠，b3 仍在眼前，所以提示 decompress）
    const { context, decision } = await E.onPrompt(db, bdb, { sessionId: SID, turn: 10, prompt: 'deploy.sh 部署脚本最后修好没', peers })
    assert.match(context, /\[回忆 · fold-recall\][\s\S]*deploy\.sh 最终结果/)
    assert.match(context, /decompress b3/)
    assert.ok(context.split('\n').length <= 3)                        // 只注入一两行
    assert.doesNotMatch(context, /遗忘|压缩时机/)
    assert.deepEqual(decision.recalled, [`${SID}#b3`])
    const mem = E.loadAll(db, bdb, peers)
    const b3 = mem.blocks.find((b) => b.key === `${SID}#b3`)
    assert.equal(b3.recalls, 1)
    assert.ok(b3.w > mem.blocks.find((b) => b.key === `${SID}#b1`).w * 10)   // 刚被找回的远比没用过的牢
  })
  await t('被找回过的块不再遗忘；遗忘有冷却；时机只记录', async () => {
    const mem = E.loadAll(db, bdb, peers)
    assert.ok(!M.forgetRuns(mem, SID).flat().some((b) => b.block_id === 'b3'))
    const { decision } = await E.onPrompt(db, bdb, { sessionId: SID, turn: 11, prompt: '写个爬虫抓天气预报', peers })
    assert.equal(decision.forget, undefined)                          // 上一轮刚遗忘过，冷却中
    assert.equal(decision.timing_asked, false)                        // 时机判断也有冷却（上次在第 9 轮）
    assert.equal(compressed.length, 1)
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
  await t('作废：被推翻的块不再找回、不进候选、不当最新进展；撤销后恢复', async () => {
    const memBefore = E.loadAll(db, bdb, peers)
    const b3 = memBefore.blocks.find((b) => b.session_id === SID && b.block_id === 'b3')
    const ask = () => E.onPrompt(db, bdb, { sessionId: SID, turn: 77, prompt: 'deploy.sh 部署脚本最后怎么样了', peers, dryRun: true, timeoutMs: 5000 })
    const before = await ask()
    assert.ok((before.decision.recalled ?? []).includes(b3.key))            // 作废前：会找回 b3
    S.supersede(db, M.contentKey(b3), b3.key, '测试：结论已被推翻')
    const after = await ask()
    assert.ok(!(after.decision.recalled ?? []).includes(b3.key))
    const mem = E.loadAll(db, bdb, peers)
    M.score(mem, 'deploy.sh 部署脚本最后怎么样了')
    assert.ok(!M.candidates(mem, 24, { current: SID }).some((b) => b.key === b3.key))
    assert.ok(!M.mentioned(mem).some((b) => b.key === b3.key))
    const b2 = mem.blocks.find((b) => b.session_id === SID && b.block_id === 'b2')
    assert.notEqual(M.latestInThread(mem, S.linksFrom(db), b2).key, b3.key)
    assert.equal(mem.blocks.find((b) => b.key === b3.key).keep, 0)
    assert.equal(S.supersededList(db).length, 1)
    assert.ok(S.unsupersede(db, M.contentKey(b3)))
    const back = await ask()
    assert.ok((back.decision.recalled ?? []).includes(b3.key))              // 撤销后：又能找回
  })
  await t('分工：别的会话的偏好/结论只给指引，过程照旧带摘要；FOLD_RECALL_DEFER=none 关掉', () => {
    const mk = (type, block_id, summary) => ({ type, block_id, summary, topic: '主题' + block_id, session_id: OTHER, active: false, created_at: T0 })
    const picked = [mk('preference', 'b1', '回复一律用中文'), mk('knowledge', 'b2', '端口是 18787'), mk('episode', 'b3', 'rsync 失败后清磁盘')]
    const txt = M.recallText(SID, picked)
    assert.ok(!/一律用中文|18787/.test(txt) && /偏好\/约定类/.test(txt) && /结论类/.test(txt) && /rsync 失败后清磁盘/.test(txt), txt)
    process.env.FOLD_RECALL_DEFER = 'none'
    try { const all = M.recallText(SID, picked); assert.ok(/一律用中文/.test(all) && /18787/.test(all), all) } finally { delete process.env.FOLD_RECALL_DEFER }
  })
  await t('事件记录：每轮记 git 改动/提交/还原、报错、待办；压缩盖住最近一轮后注入一次续接快照', async () => {
    const { execFileSync } = await import('node:child_process')
    const { writeFileSync, mkdirSync, unlinkSync } = await import('node:fs')
    const J = await import('../lib/journal.mjs')
    const repo = join(dir, 'repo'); mkdirSync(repo)
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' })
    g('init', '-q'); writeFileSync(join(repo, 'a.txt'), 'one\n'); g('add', '.'); g('commit', '-qm', 'init')
    assert.equal(J.freshCompaction(db, bdb, SID), null)                      // 第一次只记下时刻
    // 第 1 轮：改 a.txt，新建 b.txt
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n'); writeFileSync(join(repo, 'b.txt'), 'tmp')
    const r1 = J.recordTurn(db, bdb, { sessionId: SID, turn: 1, cwd: repo, lastReply: '签名校验已实现。下一步：补回调重放的测试。要提交吗？' })
    assert.deepEqual(r1.git.dirty, { 'a.txt': '+1 −0', 'b.txt': '新文件' })
    assert.ok(r1.todos.some((x) => /下一步/.test(x)) && r1.todos.some((x) => /要提交吗/.test(x)))
    assert.ok(r1.errors[0].includes('<已脱敏>'))
    // 第 2 轮：提交 a.txt，删掉 b.txt（改过又还原）
    g('commit', '-qam', '签名校验'); unlinkSync(join(repo, 'b.txt'))
    const r2 = J.recordTurn(db, bdb, { sessionId: SID, turn: 2, cwd: repo, lastReply: '已提交。' })
    assert.equal(r2.commits.length, 1); assert.match(r2.commits[0], /签名校验$/)
    assert.deepEqual(r2.reverted, ['b.txt'])
    assert.equal(J.freshCompaction(db, bdb, SID), null)                      // 没有新块
    // billion-context 压缩：一个旧块（像遗忘的索引）不触发；盖住最近一轮的新块触发
    const w = new DatabaseSync(process.env.BILI_INDEX_DB)
    const ins = w.prepare('insert into blocks values (?,?,?,?,?,?,?,?,?)')
    ins.run('b90', SID, 90, 1, 100, 2, 1, Date.now() + 5, JSON.stringify({ topic: '旧工作索引', summary: '' }))
    assert.equal(J.freshCompaction(db, bdb, SID), null)
    ins.run('b91', SID, 91, 2960, 3001, 1, 1, Date.now() + 10, JSON.stringify({ topic: '签名校验', summary: '做完了' }))
    w.close()
    await new Promise((r) => setTimeout(r, 15))
    const snap = J.continuation(db, bdb, SID, repo)
    assert.ok(snap.length <= J.SNAPSHOT_MAX)
    for (const re of [/续接 · fold-recall/, /b91/, /第 1 轮：把支付回调的签名校验做了/, /工作区干净/, /本会话的提交：\w+ 签名校验/, /改过又还原的文件：b\.txt/, /最近的报错/, /下一步：补回调重放的测试/]) assert.match(snap, re)
    assert.equal(J.continuation(db, bdb, SID, repo), '')                     // 同一次压缩只注入一次
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
