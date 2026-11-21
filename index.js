// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * dsh-tool-fold v0.2.0 — 把用不到的工具收成「一行名字 + 一句描述」。
 *
 * 机制：ctx.tools.restrict({ deny }) 是 DSH 自带的按作用域可见性过滤。
 * 只能作用在**某个 agent 的作用域**上（宿主拒绝全局限制，否则会一次遮住所有 agent），
 * 所以在 agent/pre-step 里拿到 agent 之后，用 agent.ctx 施加。
 *
 * v0.2.0 的四件事：
 *  1. status 报真实计量：折叠数 / 省下的字节 / 估算 token
 *  2. load 状态**按会话隔离**（v0.1 是全局一份，A 会话 load 了 B 会话也跟着有，是 bug）
 *  3. 支持 ~/.dsh/tool-fold.json 覆写名单，改配置不用改代码
 *  4. 缓存纪律：每个会话只在第一步定型一次，中途绝不增删
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 这些名字无论配置怎么写都不会被折叠 */
const NEVER_FOLD = new Set([
  'tool_fold',
  'pwsh',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'read_image',
  'ask_user_question',
  'todo_write',
  'present',
  'skill',
  'working_directory',
  'job_output',
  'job_kill',
  'job_list',
])

const DEFAULT_FOLD = [
  // 远程主机
  'remote_list_hosts',
  'remote_list_workspaces',
  'remote_create_session',
  'remote_send_message',
  'remote_read_session',
  'remote_interrupt_session',
  'remote_wait_sessions',
  'remote_list_sessions',
  'remote_upload_file',
  'remote_download_file',
  'remote_get_operation',
  // 团队任务
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  // 定时任务
  'schedule_create',
  'schedule_list',
  'schedule_view',
  'schedule_edit',
  // 子代理 / 编排
  'workflow',
  'subagent',
  'subagent_fork',
  'list_agents',
  'send_message',
  'wait_agent',
  'list_subagent_models',
  // 低频桌面控制
  'cu_recover',
  'cu_verify',
  'cu_drag',
  'cu_cursor',
  'cu_clipboard',
  'cu_window_info',
  // 其他
  'create_worktree',
  'plugin_market',
  'plugin_manager',
  'load_workspace_dependencies',
  'exit_plan_mode',
  'get_goal',
  'update_goal',
  'create_goal',
  'present',
  'cordis_inspect_list',
  'cordis_inspect_query',
  // 官方可选插件带来的低频能力
  'ralph',
  'terminal_open',
  'terminal_read',
  'terminal_send',
  'terminal_close',
  'terminal_list',
  'terminal_signal',
  'user_terminal_list',
  'user_terminal_read',
]

const CONFIG_PATH = join(homedir(), '.dsh', 'tool-fold.json')

/** 读用户配置文件；坏了就当没有，绝不让插件起不来。 */
function readUserConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

const clip = (text, n) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 一个工具在请求里实际占多少字节（就是它进 schema 的那部分） */
function schemaBytes(def) {
  try {
    return Buffer.byteLength(
      JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters }),
    )
  } catch {
    return 0
  }
}

export const inject = ['tools']

export function apply(ctx, config = {}) {
  // 行配置优先于文件配置：用户改 cordis 那一行时不用去动 home 目录
  const merged = { ...readUserConfig(), ...(config ?? {}) }
  if (merged.enabled === false) return

  const list = Array.isArray(merged.fold) && merged.fold.length > 0 ? merged.fold : DEFAULT_FOLD
  const keep = new Set(Array.isArray(merged.keep) ? merged.keep : [])
  const folded = new Set(
    list.filter((name) => typeof name === 'string' && !NEVER_FOLD.has(name) && !keep.has(name)),
  )

  /** 名字 → { desc, bytes }，在限制生效前抓（之后 get() 读不到） */
  const catalog = new Map()
  /** 会话 key → { agent, dispose, loaded:Set<string> } */
  const sessions = new Map()
  let lastKey = null

  const buildCatalog = (agent) => {
    for (const name of folded) {
      if (catalog.has(name)) continue
      try {
        const def = agent?.ctx?.tools?.get?.(name)
        if (def) catalog.set(name, { desc: clip(def.description, 90), bytes: schemaBytes(def) })
      } catch {
        /* 拿不到就跳过 */
      }
    }
  }

  const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

  /** 限制还生效吗？随便挑一个被折的名字，看得见就说明它被解除了 */
  const restrictionActive = (agent, deny) => {
    if (deny.length === 0) return true
    try {
      return agent?.ctx?.tools?.get?.(deny[0]) === undefined
    } catch {
      return true
    }
  }

  const ensureRestriction = (agent) => {
    const key = agent?.id ?? agent
    let rec = sessions.get(key)
    if (!rec) {
      rec = { agent, dispose: null, loaded: new Set(), deny: [], hooked: false }
      sessions.set(key, rec)
    }
    rec.agent = agent
    buildCatalog(agent)

    const deny = [...catalog.keys()].filter((name) => !rec.loaded.has(name))

    // 快路径：集合没变、限制仍在 → 一个字节都不动。
    // 每一步都调用它，靠这里挡住「无谓的重建」，避免制造缓存抖动。
    if (sameSet(deny, rec.deny) && restrictionActive(agent, deny)) return

    // 先把新的装上，成功之后才拆旧的。
    // v0.2.0 是「先拆后建」：建失败就只剩拆 —— 工具被放出来、下一轮又装回去，来回抖。
    let next = null
    if (deny.length > 0 && agent?.ctx?.tools?.restrict) {
      try {
        const d = agent.ctx.tools.restrict({ deny })
        next = typeof d === 'function' ? d : null
      } catch {
        next = null
      }
    }

    const prev = rec.dispose
    if (typeof prev === 'function') {
      try {
        prev()
      } catch {
        /* 旧的限制可能已随 agent 一起没了 */
      }
    }
    rec.dispose = next
    rec.deny = deny

    // 解除函数必须挂在本插件的 effect 上，否则禁用插件时限制会泄漏，
    // 工具被永久遮住、只能重启才回来（v0.1 的真实 bug）。
    if (!rec.hooked) {
      rec.hooked = true
      ctx.effect(() => () => {
        try {
          rec.dispose?.()
        } catch {
          /* 已随 agent 一起没了 */
        }
        rec.dispose = null
      })
    }
  }

  // 每一步都检查一次，但只有两种情况会真的动工具表：
  //   1) 本会话第一次见（首次施加）
  //   2) 限制被别人解除了，或 load 改了集合
  // 其余情况走快路径，不碰工具表 —— 否则每轮都重建，前缀缓存就会一直抖。
  ctx.on('agent/pre-step', (payload, next) => {
    const agent = payload?.agent
    if (agent) {
      lastKey = agent?.id ?? agent
      ensureRestriction(agent)
    }
    return next()
  })

  const totalBytes = () => [...catalog.values()].reduce((sum, e) => sum + e.bytes, 0)

  const tool = {
    name: 'tool_fold',
    description:
      '本会话把一批低频工具折叠成了「只有名字和一句话」的形式以省上下文（远程主机 / 团队任务 / 定时任务 / 子代理编排 / 低频桌面控制）。' +
      '需要其中某个时：先 action:"list" 看折叠了什么，再 action:"load" + name 取回来（下一轮可用，之后就与普通工具无异地调用）。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'load', 'status'],
          description: 'list 列折叠清单 / load 取回一个工具 / status 看计量',
        },
        name: { type: 'string', description: 'load 时要取回的工具名' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    execute: async (args, exec) => {
      const action = args?.action ?? 'list'
      // 调用方会话优先从执行上下文取；拿不到才退回最近一次 pre-step 的会话。
      // 两个会话并发跑时，全局 lastKey 会张冠李戴。
      const callerKey = exec?.agent?.id ?? exec?.session?.id ?? lastKey
      const rec = sessions.get(callerKey)

      if (action === 'status') {
        const bytes = totalBytes()
        const loadedNow = rec ? rec.loaded.size : 0
        // 3.2 是经验值：中英混排 JSON 大约 3.2 字节/token
        const tokens = Math.round(bytes / 3.2)
        // 单向门自检：如果有人把恢复入口自己折进去，这里会非空。正常必须是空集。
        const stuck = [...catalog.keys()].filter((name) => NEVER_FOLD.has(name))
        return {
          text:
            `折叠 ${catalog.size} 个工具，省下约 ${bytes} 字节（≈${tokens} token）。` +
            `本会话已取回 ${loadedNow} 个。` +
            (stuck.length === 0 ? '恢复入口完好。' : `⚠ 有 ${stuck.length} 个不可恢复项：${stuck.join(', ')}`) +
            `配置来源：${CONFIG_PATH}（可缺省）。`,
        }
      }

      if (action === 'load') {
        const name = String(args?.name ?? '').trim()
        if (!name) return { text: '✗ 需要 name' }
        if (!catalog.has(name)) return { text: `✗ 「${name}」不在折叠清单里（没被折叠，或者不存在）` }
        const current = sessions.get(lastKey)
        if (!current) return { text: '✗ 还没有活动会话，取回失败' }
        if (current.loaded.has(name)) return { text: `「${name}」本会话已经取回了。` }
        current.loaded.add(name)
        ensureRestriction(current.agent)
        return { text: `✓ 「${name}」已取回，下一轮开始可直接调用。` }
      }

      const loadedNow = rec?.loaded ?? new Set()
      const rows = [...catalog.entries()].filter(([name]) => !loadedNow.has(name))
      if (rows.length === 0) return { text: '折叠清单是空的：所有工具都已直接可用。' }
      return { text: rows.map(([name, e]) => `${name}：${e.desc}`).join('\n') }
    },
  }

  ctx.effect(() => ctx.tools.register(tool))
}
