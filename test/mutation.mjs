// test/mutation.mjs — 变异测试：把实现里每条关键规则改坏一次，确认自测真的会失败。
//
// 为什么要有它：断言"测试过了"很容易，改坏实现再跑一遍才知道断言真的在盯这条规则。
// 每个变异都必须让 node test/selftest.mjs 失败；没失败的变异说明对应规则没有测试兜住。
//
// 用法：node test/mutation.mjs
import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const M = join(root, 'lib', 'memory.mjs')
const E = join(root, 'lib', 'engine.mjs')
const BACK = join(root, '.mutation-backup')

const MUTATIONS = [
  {
    file: E, name: 'C 路也把候选交给后台（后台就可能回忆出东西）',
    from: "const candKeys = routed.route === 'B' ? cands.map((b) => b.key) : []",
    to: "const candKeys = routed.route === 'A' ? [] : cands.map((b) => b.key)"
  },
  {
    file: E, name: '把折块放回首步同步调用（第一步会被 compress 拖住）',
    from: 'dec.forget.queued = true',
    to: 'dec.forget.queued = true; await B.compress(sessionId, M.forgetIndex(splitOnRaw(bdb, sessionId, runs)))'
  },
  {
    file: M, name: '去掉"块级 df 很低"这条稀有判据（中文线索在大语料上永远挤不进去）',
    from: '(idf(t) >= cutoff || (df.get(t) ?? 0) <= rareCap)',
    to: '(idf(t) >= cutoff)'
  },
  {
    file: M, name: '稀有判据退回裸 df 10 分位（不再按 idf 判断，常见词也会被当成线索）',
    from: 'const cutoff = [...df.keys()].map(idf).sort((a, b) => b - a)[Math.floor(df.size * 0.1)] ?? 0',
    to: 'const cutoff = [...df.values()].sort((a, b) => a - b)[Math.floor(df.size * 0.1)] ?? 0'
  },
  {
    file: M, name: '去掉"上次/之前"这类明确翻旧账的意图判断（会误本地直中）',
    from: "  if (RECALL_INTENT.test(prompt)) return { route: 'B' }\n",
    to: ''
  },
  {
    file: M, name: '相邻段也算竞争对手（"最后怎么样了"的答案会被上一段压掉）',
    from: 'const rivals = top ? ranked.filter((x) => x !== top && !adjacent(x.b, top.b)) : ranked',
    to: 'const rivals = ranked.filter((x) => x !== top)'
  },
  {
    file: M, name: '去掉"第一名要领先两倍"（线索指向多块时也会直中）',
    from: 'top.score >= second * 2',
    to: 'top.score >= second'
  }
]

const run = () => {
  try {
    const out = execFileSync(process.execPath, ['test/selftest.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { failed: false, out }
  } catch (e) {
    return { failed: true, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

copyFileSync(M, BACK + '.memory.mjs')
copyFileSync(E, BACK + '.engine.mjs')
const results = []
try {
  const base = run()
  console.log(`基线（未变异）：${base.failed ? '✗ 居然没过' : '✓ 全部通过'}\n`)
  for (const mu of MUTATIONS) {
    const src = readFileSync(mu.file, 'utf8')
    if (!src.includes(mu.from)) { results.push({ ...mu, caught: false, why: '没找到要变异的代码（实现已变）' }); continue }
    writeFileSync(mu.file, src.replace(mu.from, mu.to))
    const r = run()
    copyFileSync(mu.file === M ? BACK + '.memory.mjs' : BACK + '.engine.mjs', mu.file)
    const line = (r.out.match(/AssertionError[^\n]*/) ?? [''])[0].slice(0, 90)
    results.push({ ...mu, caught: r.failed, why: r.failed ? (line || '自测失败') : '变异后自测仍然通过 —— 这条规则没有测试兜住' })
  }
} finally {
  copyFileSync(BACK + '.memory.mjs', M)
  copyFileSync(BACK + '.engine.mjs', E)
  for (const f of [BACK + '.memory.mjs', BACK + '.engine.mjs']) if (existsSync(f)) rmSync(f)
}

console.log('变异测试结果：')
let bad = 0
for (const r of results) {
  if (!r.caught) bad++
  console.log(`  ${r.caught ? '✓ 已捕获' : '✗ 没捕获'}  ${r.name}\n      ${r.why}`)
}
console.log(`\n${results.length - bad}/${results.length} 个变异被自测抓住`)
process.exit(bad ? 1 : 0)
