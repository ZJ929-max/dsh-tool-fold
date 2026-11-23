/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * test/fold-sequence.mjs — 折叠时序自测（假 ctx，不需要 DSH 运行时）
 *
 * 钉死三件事，它们正是「工具表被反复装卸」的根因：
 *   1) 开局装一次，之后每步走快路径；
 *   2) load 只记账，不在回合中途改工具表；
 *   3) restrict 抛错时**不拆**旧限制。
 *
 * 假 ctx 按 dsh-tools 的真实语义建模：restrict 往 scope 追加一条限制，
 * 解除函数**移除那一条**（不是把名字删掉），多条限制取交集。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 node test/fold-sequence.mjs
 */

import assert from 'node:assert/strict'

const NAMES = ['a1', 'a2', 'a3', 'a4', 'a5']

function makeTools(names = NAMES) {
  const registered = new Set(names)
  const restrictions = []
  const stats = { calls: 0, disposes: 0, fail: false }
  const hidden = () => names.filter((n) => restrictions.some((r) => r.deny.has(n)))
  return {
    stats,
    hidden,
    get(name) {
      if (!registered.has(name)) return undefined
      if (restrictions.some((r) => r.deny.has(name))) return undefined
      return { name, description: 'desc of ' + name, parameters: {} }
    },
    restrict({ deny }) {
      stats.calls += 1
      if (stats.fail) throw new Error('unknown global tool "ghost"')
      const unknown = deny.filter((n) => !registered.has(n))
      if (unknown.length > 0) throw new Error('unknown global tool ' + unknown.join(', '))
      const entry = { deny: new Set(deny) }
      restrictions.push(entry)
      let lifted = false
      return () => {
        stats.disposes += 1
        if (lifted) return
        lifted = true
        const i = restrictions.indexOf(entry)
        if (i >= 0) restrictions.splice(i, 1)
      }
    }
  }
}

function makeCtx() {
  const handlers = new Map()
  const effects = []
  let tool = null
  return {
    ctx: {
      on(name, fn) { handlers.set(name, fn) },
      effect(fn) { const c = fn(); if (typeof c === 'function') effects.push(c) },
      tools: { register(def) { tool = def; return () => { tool = null } } }
    },
    handlers,
    getTool: () => tool
  }
}

let passed = 0
function check(label, fn) {
  try { fn(); passed += 1; console.log('ok   ' + label) }
  catch (e) { console.log('FAIL ' + label + '\n     ' + (e instanceof Error ? e.message : String(e))); process.exitCode = 1 }
}

// 使用账本必须写到临时文件，别碰用户真实的 ~/.dsh/tool-fold-state.json
const os = await import('node:os')
const fs = await import('node:fs')
const path = await import('node:path')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-fold-'))
process.env.TOOL_FOLD_STATE = path.join(tmp, 'state.json')

const { apply } = await import('../index.js')

const { ctx, handlers, getTool } = makeCtx()
const tools = makeTools()
apply(ctx, { fold: NAMES })
const preStep = handlers.get('agent/pre-step')
assert.equal(typeof preStep, 'function', 'pre-step 必须注册')

const agent = { id: 'session-A', ctx: { tools } }
const step = (a = agent) => preStep({ agent: a }, () => {})
const tool = getTool()

check('开局第一次只装一次，全部折叠', () => {
  step()
  assert.equal(tools.stats.calls, 1)
  assert.equal(tools.hidden().length, NAMES.length)
})

check('随后两步走快路径，不再重装', () => {
  step(); step()
  assert.equal(tools.stats.calls, 1, '限制没变就不该再调用 restrict')
  assert.equal(tools.stats.disposes, 0)
})

await tool.execute({ action: 'load', name: 'a1' }, { agent })

check('load 只记账：同一步内没有重装，a1 仍被折着', () => {
  assert.equal(tools.stats.calls, 1, 'load 不应触发 restrict')
  assert.equal(tools.get('a1'), undefined, '下一个 pre-step 之前 a1 仍是折的')
})

check('下一次 pre-step 才生效：拆旧的、装新的，a1 露出', () => {
  step()
  assert.equal(tools.stats.calls, 2)
  assert.equal(tools.stats.disposes, 1, '旧限制应被解除一次')
  assert.equal(tools.hidden().length, NAMES.length - 1)
  assert.notEqual(tools.get('a1'), undefined)
})

check('restrict 抛错时不拆旧限制，折叠结果原样保留', () => {
  const d0 = tools.stats.disposes
  const hidden0 = tools.hidden().length
  tools.stats.fail = true
  step()
  assert.equal(tools.stats.disposes, d0, '装失败时不许 dispose')
  assert.equal(tools.hidden().length, hidden0, '现有折叠必须原样保留')
  tools.stats.fail = false
})

check('全新会话首次安装失败时不产生任何限制，恢复后能装上（不会来回抖）', () => {
  const fresh = makeTools()
  const freshAgent = { id: 'session-B', ctx: { tools: fresh } }
  fresh.stats.fail = true
  step(freshAgent)
  assert.equal(fresh.hidden().length, 0, '装失败时不该有半套限制')
  const callsAfterFail = fresh.stats.calls
  fresh.stats.fail = false
  step(freshAgent)
  assert.equal(fresh.stats.calls, callsAfterFail + 1, '下一步应当重试')
  assert.equal(fresh.hidden().length, NAMES.length, '重试成功后应全部折叠')
  // 再走一步必须是快路径，否则就是「装了又拆」的抖动
  const settled = fresh.stats.calls
  step(freshAgent)
  assert.equal(fresh.stats.calls, settled, '成功之后必须稳定，不再调用 restrict')
})

const status = await tool.execute({ action: 'status' }, { agent })
check('status 摊开重装次数与已取回数量', () => {
  assert.match(status.text, /工具表重装 \d+ 次/)
  assert.match(status.text, /本会话已取回 1 个/)
})

/* ---------- 上游口径：用过一次就永久免折，且从下一个会话生效 ---------- */
check('工具真被调用后，使用账本落盘', () => {
  const useHandler = handlers.get('tools/result')
  assert.equal(typeof useHandler, 'function', '必须监听 tools/result')
  useHandler({ name: 'a3' })
  const saved = JSON.parse(fs.readFileSync(process.env.TOOL_FOLD_STATE, 'utf8'))
  assert.equal(saved.used.a3, 1)
})

check('本会话内不因「用过」而改工具表（与上游一致：下次会话才生效）', () => {
  assert.equal(tools.hidden().length, NAMES.length - 1, 'a1 已 load，a3 仍在本会话里折着')
})

const ctx2 = makeCtx()
const tools2 = makeTools()
apply(ctx2.ctx, { fold: NAMES })
const agent2 = { id: 'session-C', ctx: { tools: tools2 } }
ctx2.handlers.get('agent/pre-step')({ agent: agent2 }, () => {})
const status2 = await ctx2.getTool().execute({ action: 'status' }, { agent: agent2 })

check('下一个会话不再折叠用过的工具', () => {
  assert.equal(tools2.hidden().length, NAMES.length - 1, 'a3 应该免折，其余仍折')
  assert.notEqual(tools2.get('a3'), undefined, 'a3 应直接可见，不需要再 load')
  assert.match(status2.text, /已因用过永久免折 1 个/)
})

console.log('\n' + passed + ' checks passed')
