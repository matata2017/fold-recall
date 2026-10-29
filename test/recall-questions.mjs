// test/recall-questions.mjs — 交接文档 §3.5 的"27 道回忆题"。
//
// 重要：原来的 27 道题不在仓库里（交接文档第 142 行明确写了"题目文件不在仓库里，需要重新出题"），
// 这里按本机真实语料（state.db 的记忆块）重新出题，所以结果只能算"重建题"上的表现，
// 不能声称等于原来的 27 题。题目是照着块的标题写的，答案来自标题本身，不是照着 route() 的输出反推的。
//
// 判据：目标块必须进入候选（hit），并且 route() 判 A 时选中块必须就是目标块（exact）。
// 用法：node test/recall-questions.mjs
import '../lib/quiet.mjs'
import { DatabaseSync } from 'node:sqlite'
import * as E from '../lib/engine.mjs'
import * as M from '../lib/memory.mjs'

const db = new DatabaseSync(process.env.FOLD_RECALL_HOME || 'C:/Users/Admin/.fold-recall/state.db', { readOnly: true })
const bdb = new DatabaseSync(process.env.BILI_INDEX_DB || 'C:/Users/Admin/.local/share/billion-context/sessions/index.db', { readOnly: true })
const peers = db.prepare('select session_id from sessions').all().map((r) => r.session_id)
const S = 'session-644f9ee0-7b71-47f0-ac7a-827474fc5dcd'

const Q = [
  ['package.json 改名之后 GitHub 首推那次成功了吗', 'b4'], ['matata2017/dsh-codex-hooks 的 topics 加上 dsh-plugin 了吗', 'b5'],
  ['CODEX 截图里 Hook stats 的入口到底在哪个位置', 'b8'], ['lib/runs.js 的运行记录是怎么实现的', 'b9'],
  ['/hooks 命令在 CODEX 里是怎么注册和设计的', 'b11'], ['输入框旁边的钩子图标弹出来的浮层是怎么做的', 'b16'],
  ['client.js 里 factory 那段重写改了什么', 'b19'], ['dsh-src 里的 hook-protocol 包提供了什么', 'b21'],
  ['钩子配置放在 ~/.dsh/hooks.json 用 DSH 原生事件名，这事定下来了吗', 'b22'],
  ['lib/core.js 头部注释改成 normalization fingerprint matcher 是怎么回事', 'b26'],
  ['settings-general 那个 store 的 open 和 activeId 是怎么定义的', 'b30'],
  ['用户说点了全部信任这个数字不会变，那条反馈最后怎么处理的', 'b33'],
  ['e382242 那次把图标改回审查弹窗加红点', 'b36'], ['0.3.0 版本发布那一轮都做了什么', 'b39'],
  ['codex-rs 仓库 HEAD 342ed69 里的 hooks crate 调研结论', 'b40'],
  ['PR #8665 是在 awesome-dsh-plugin 哪个仓库提的', 'b44'], ['StartLux 源码核查的结果是什么', 'b45'],
  ['mnemon_status 体检说 healthy 是几个空间几个动作', 'b46'], ['用户纠正说我们用的是 dsh-mnemon 不是 hindsight', 'b48'],
  ['e71320e 修的那版 Hook stats 显示运行 5 拦截 0 失败 0', 'b50'],
  ['阶跃星辰那个 turn 作用域改造查出 P0 到 P6', 'b51'], ['点哪条消息就看哪一轮那个 P6 攻关怎么做的', 'b53'],
  ['lib/runs.js 删掉 fallbackTurn 那个猜测是哪个版本', 'b54'], ['0.4.0 那版的 selftest 判别用例补了什么', 'b55'],
  ['session-6a3dc8b0 这个监工会话最后的结论和测试数', 'b56'], ['0.5.0 和 0.5.1 两版交付之后验收是怎么派工的', 'b59'],
  ['hooks.state.json 的信任状态被抹掉是怎么查的', 'b60'],
]

const mem0 = E.loadAll(db, bdb, peers)
console.log(`语料块数=${mem0.blocks.length} 题数=${Q.length}（重建题，非原始 27 题）\n`)
let hit = 0, exact = 0, routeA = 0, routeB = 0
const misses = []
for (const [q, want] of Q) {
  const mem = E.loadAll(db, bdb, peers)
  M.score(mem, q)
  const cands = M.candidates(mem, 24, { current: S })
  const inC = cands.some((b) => b.block_id === want)
  const r = M.route(mem, q, cands)
  if (inC) hit++
  if (r.route === 'A') { routeA++; if (r.block?.block_id === want) exact++ }
  if (r.route === 'B') routeB++
  if (!inC || (r.route === 'A' && r.block?.block_id !== want)) misses.push(`  ${want}: ${inC ? '在候选但路由 ' + r.route + (r.block ? '→' + r.block.block_id : '') : '不在候选'} | ${q}`)
}
console.log(`目标块进入候选 = ${hit}/${Q.length}`)
console.log(`route A = ${routeA}（其中命中目标 ${exact}），route B = ${routeB}`)
if (misses.length) console.log('\n未达标：\n' + misses.join('\n'))
db.close(); bdb.close()
