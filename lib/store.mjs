// store.mjs — fold-recall 自己的状态库（与 billion-context 的库分开，只存我们的判断与事件）
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = process.env.FOLD_RECALL_HOME || join(homedir(), '.fold-recall')

const SCHEMA = `
create table if not exists sessions  (session_id text primary key, cwd text, host text, seen_at integer);
create table if not exists meta      (key text primary key, type text, p_key real, p_useful real, summary_len integer, judged_at integer);
create table if not exists links     (from_key text, to_key text, kind text, p real, primary key (from_key, to_key));
create table if not exists events    (key text, kind text, weight real, session_id text, ref integer, ts integer);
create table if not exists turns     (session_id text, turn text, ts integer, primary key (session_id, turn));
create table if not exists hints     (session_id text primary key, last_timing_ref integer, last_forget_ref integer);
create table if not exists decisions (ts integer, session_id text, turn text, json text);
create table if not exists labels    (session_id text, turn text, context_need text, note text, ts integer, primary key (session_id, turn));
create index if not exists events_key on events(key);
create table if not exists superseded (content_key text primary key, key text, reason text, ts integer);
create table if not exists journal   (session_id text, turn text, ts integer, end_ref integer, json text, primary key (session_id, turn));
create table if not exists kv        (session_id text, k text, v text, primary key (session_id, k));
`

export function openStore() {
  mkdirSync(HOME, { recursive: true })
  const db = new DatabaseSync(join(HOME, 'state.db'))
  db.exec('pragma journal_mode = wal; pragma busy_timeout = 3000;' + SCHEMA)
  return db
}

export const now = () => Date.now()

// 同一目录在不同宿主里写法不同（D:\a\b、D:/a/b、d:/a/b/），统一后才能按目录认出同项目的会话
export const normCwd = (cwd) => (cwd ? String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').replace(/^[A-Z]:/, (d) => d.toLowerCase()) : null)

export function rememberSession(db, sessionId, cwd, host) {
  cwd = normCwd(cwd)
  db.prepare('insert into sessions values (?,?,?,?) on conflict(session_id) do update set cwd=coalesce(excluded.cwd, cwd), seen_at=excluded.seen_at')
    .run(sessionId, cwd ?? null, host ?? null, now())
}

export function projectPeers(db, sessionId) {
  const row = db.prepare('select cwd from sessions where session_id=?').get(sessionId)
  if (!row?.cwd) return [sessionId]
  return db.prepare('select session_id from sessions where cwd=?').all(row.cwd).map((r) => r.session_id)
}

/** 同一轮只处理一次（DSH 的 agent/pre-step 每步都会触发） */
export function firstSeen(db, sessionId, turn) {
  const r = db.prepare('insert or ignore into turns values (?,?,?)').run(sessionId, String(turn), now())
  return r.changes > 0
}

export function metaMap(db) {
  return new Map(db.prepare('select * from meta').all().map((r) => [r.key, r]))
}
export function linksFrom(db) {
  return db.prepare('select * from links').all()
}
export function eventsFor(db) {
  return db.prepare('select key, kind, weight, session_id, ref, ts from events').all()
}
export function addEvent(db, key, kind, weight, sessionId, ref) {
  db.prepare('insert into events values (?,?,?,?,?,?)').run(key, kind, weight, sessionId, ref ?? 0, now())
}
export function getHints(db, sessionId) {
  return db.prepare('select * from hints where session_id=?').get(sessionId) ?? { last_timing_ref: null, last_forget_ref: null }
}
export function setHint(db, sessionId, field, ref) {
  db.prepare(`insert into hints (session_id, ${field}) values (?,?) on conflict(session_id) do update set ${field}=excluded.${field}`).run(sessionId, ref)
}
// 作废：内容已被推翻的记忆块（按内容记，复制/恢复出的同内容副本一起作废）。原文不删，只是不再找回、不再加强、优先移出上下文
export function supersede(db, contentKey, key, reason) {
  db.prepare('insert into superseded values (?,?,?,?) on conflict(content_key) do update set reason=excluded.reason, ts=excluded.ts')
    .run(contentKey, key, reason ?? '', now())
}
export function unsupersede(db, contentKey) {
  return db.prepare('delete from superseded where content_key=?').run(contentKey).changes > 0
}
export function supersededSet(db) {
  return new Set(db.prepare('select content_key from superseded').all().map((r) => r.content_key))
}
export function supersededList(db) {
  return db.prepare('select key, reason, ts from superseded order by ts desc').all()
}

// 事件记录：每轮结束时记一条（请求、报错、git 改动/提交/撤回、提到的待办），压缩后据此拼续接快照
export function addJournal(db, sessionId, turn, endRef, obj) {
  db.prepare('insert or replace into journal values (?,?,?,?,?)').run(sessionId, String(turn), now(), endRef ?? 0, JSON.stringify(obj))
}
export function journalFor(db, sessionId, limit = 30) {
  return db.prepare('select turn, ts, end_ref, json from journal where session_id=? order by ts desc limit ?').all(sessionId, limit)
    .reverse().map((r) => ({ turn: r.turn, ts: r.ts, end_ref: r.end_ref, ...JSON.parse(r.json) }))
}
export const getKv = (db, sessionId, k) => db.prepare('select v from kv where session_id=? and k=?').get(sessionId, k)?.v ?? null
export const setKv = (db, sessionId, k, v) => db.prepare('insert or replace into kv values (?,?,?)').run(sessionId, k, String(v))

export function logDecision(db, sessionId, turn, obj) {
  db.prepare('insert into decisions values (?,?,?,?)').run(now(), sessionId, String(turn), JSON.stringify(obj))
}
