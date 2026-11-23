// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * dsh-lazy-tools（原型）— 把用不到的工具收成「一行名字 + 一句描述」。
 * 原名 dsh-tool-fold；改名是为了把版本号按新方案从 0.0.1 重新起算。
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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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
  // view_image 是 read_image 的兜底，折了会让「读图失败」没有下一步
  'view_image',
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
  // 整合包自己的低频工具：B 站只在被问到时读
  'bili_search',
  'bili_video',
  'bili_comments',
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

const CONFIG_PATH = join(homedir(), '.dsh', 'lazy-tools.json')
/** 改名前的配置文件；读不到新文件时回退，别让用户重新配一遍 */
const LEGACY_CONFIG_PATH = join(homedir(), '.dsh', 'tool-fold.json')

/**
 * 使用账本。
 *
 * 上游 toolprune 的规则是「一个工具只要被真正调用过，就永久不再提议裁掉」
 * （"one ever seen in use is never proposed"、"a single use protects it for good"），
 * 而且他们的决定**从下一个会话开始生效**，绝不在会话中途改工具表。
 *
 * 我们的 load 是内存态：会话一结束就清零，于是「每个会话都要用的工具」每个
 * 会话都得重新 load 一遍 —— 用户看到的就是「装回来、又被折回去」。所以这里
 * 把使用记录落到磁盘，下一次加载时不再折叠它。
 */
const STATE_PATH = (() => {
  const override = process.env.LAZY_TOOLS_STATE ?? process.env.TOOL_FOLD_STATE
  if (typeof override === 'string' && override.trim() !== '') return override
  return join(homedir(), '.dsh', 'lazy-tools-state.json')
})()
/** 改名前的账本；新文件不存在时读它，免得「用过免折」的记录白丢一次 */
const LEGACY_STATE_PATH = join(homedir(), '.dsh', 'tool-fold-state.json')

function readState() {
  const candidates = STATE_PATH === LEGACY_STATE_PATH ? [STATE_PATH] : [STATE_PATH, LEGACY_STATE_PATH]
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object') continue
      return { ...parsed, used: parsed.used && typeof parsed.used === 'object' ? parsed.used : {} }
    } catch {
      /* 换下一个 */
    }
  }
  return { used: {} }
}

function writeState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    const tmp = `${STATE_PATH}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, STATE_PATH)
  } catch {
    /* 记账失败绝不能影响会话 */
  }
}

/** 读用户配置文件；坏了就当没有，绝不让插件起不来。 */
function readUserConfig() {
  for (const file of [CONFIG_PATH, LEGACY_CONFIG_PATH]) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      /* 换下一个；都没有就当没配置 */
    }
  }
  return {}
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
  /** 配置里所有允许折叠的名字（还没扣掉「用过」的） */
  const watch = new Set(
    list.filter((name) => typeof name === 'string' && !NEVER_FOLD.has(name) && !keep.has(name)),
  )

  const state = readState()
  /** 用过一次就永久免折 —— 上游的口径，跨会话保留 */
  const graduated = new Set([...watch].filter((name) => Number(state.used?.[name] ?? 0) > 0))
  const folded = new Set([...watch].filter((name) => !graduated.has(name)))

  let dirty = false
  const flushState = () => {
    if (!dirty) return
    dirty = false
    writeState(state)
  }
  const recordUse = (name) => {
    if (typeof name !== 'string' || !watch.has(name)) return
    state.used[name] = (state.used[name] ?? 0) + 1
    if (!state.lastUsedAt || typeof state.lastUsedAt !== 'object') state.lastUsedAt = {}
    state.lastUsedAt[name] = Date.now()
    dirty = true
    // 第一次用立刻落盘（这决定下一个会话折不折它），之后每 20 次合并写一次
    if (state.used[name] === 1 || state.used[name] % 20 === 0) flushState()
  }

  // 只在「这一步真的调用了某个被折叠名单里的工具」时记账。
  // 记账不改当前会话的工具表：与上游一致，生效从下一个会话开始。
  ctx.on('tools/result', (exec) => {
    try {
      recordUse(exec?.name)
    } catch {
      /* 观察者不能让工具调用失败 */
    }
  })
  ctx.effect(() => () => flushState())

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

  /**
   * 限制还生效吗？
   *
   * v0.2.1 只抽查 deny[0]：那一个名字若恰好被 scope 里别的限制挡住，
   * 就会被误判成「我们的限制还在」，于是永远不再重装。这里逐个核对 ——
   * 几十次内存查表，换一个不会说假话的判断。
   */
  const restrictionActive = (agent, deny) => {
    if (deny.length === 0) return true
    try {
      const tools = agent?.ctx?.tools
      if (!tools?.get) return true
      for (const name of deny) {
        if (tools.get(name) !== undefined) return false
      }
      return true
    } catch {
      // 查不出来就当「还在」：宁可少装一次，也不要在不确定时拆限制
      return true
    }
  }

  /**
   * 施加/更新限制。三条硬规则：
   *  1) 装不上（restrict 抛错）就**什么都不拆**，保持上一份，记下原因下轮再试；
   *  2) 只有新限制确认装上了，才拆旧的；
   *  3) 真正改动工具表的次数记进 rec.reinstalls，由 status 摊开，抖动可观测。
   */
  const ensureRestriction = (agent, { force = false } = {}) => {
    const key = agent?.id ?? agent
    let rec = sessions.get(key)
    if (!rec) {
      rec = { agent, dispose: null, loaded: new Set(), deny: [], hooked: false, reinstalls: 0, lastError: null }
      sessions.set(key, rec)
    }
    rec.agent = agent
    buildCatalog(agent)

    const deny = [...catalog.keys()].filter((name) => !rec.loaded.has(name))

    // 快路径：集合没变、限制仍在 → 一个字节都不动。
    // 每一步都调用它，靠这里挡住「无谓的重建」，避免制造缓存抖动。
    if (!force && sameSet(deny, rec.deny) && restrictionActive(agent, deny)) return

    let next = null
    let failure = null
    if (deny.length > 0) {
      if (!agent?.ctx?.tools?.restrict) {
        failure = new Error('当前 scope 没有 tools.restrict，无法折叠')
      } else {
        try {
          const d = agent.ctx.tools.restrict({ deny })
          if (typeof d === 'function') next = d
          else failure = new Error('restrict() 没有返回解除函数')
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
        }
      }
    }

    // 装不上就到此为止：旧限制原样留着，下一轮再试。
    // 以前这里会继续往下走、把旧的 dispose 掉 —— 限制被拆光、工具全露出来、
    // 下一轮再装回去，就是「拆了又装」那种来回抖的来源。
    if (failure) {
      rec.lastError = String(failure.message ?? failure).slice(0, 200)
      return
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
    rec.lastError = null
    rec.reinstalls += 1

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
      '本会话把一批低频工具折叠成了「只有名字和一句话」的形式以省上下文（远程主机 / 团队任务 / 定时任务 / 子代理编排 / 低频桌面控制 / B 站只读）。' +
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
            `本会话已取回 ${loadedNow} 个，工具表重装 ${rec ? rec.reinstalls : 0} 次。` +
            `已因用过永久免折 ${graduated.size} 个。` +
            (rec?.lastError ? `⚠ 上次安装失败：${rec.lastError}` : '') +
            (stuck.length === 0 ? '恢复入口完好。' : `⚠ 有 ${stuck.length} 个不可恢复项：${stuck.join(', ')}`) +
            `配置来源：${CONFIG_PATH}（可缺省）。`,
        }
      }

      if (action === 'load') {
        const name = String(args?.name ?? '').trim()
        if (!name) return { text: '✗ 需要 name' }
        if (!catalog.has(name)) return { text: `✗ 「${name}」不在折叠清单里（没被折叠，或者不存在）` }
        // 必须用调用方会话：并发时 lastKey 会被另一个会话覆盖（v0.2.1 真实 bug）
        const current = sessions.get(callerKey)
        if (!current) return { text: '✗ 还没有活动会话，取回失败' }
        if (current.loaded.has(name)) return { text: `「${name}」本会话已经取回了。` }
        current.loaded.add(name)
        // 只记账，不在回合中途改工具表：真正的重装交给下一次 pre-step。
        // 回合中途 restrict/dispose，会让「这一轮」和「下一轮」看到的工具表不一样，
        // 用户看到的就是「加载一半又被移除」。
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
