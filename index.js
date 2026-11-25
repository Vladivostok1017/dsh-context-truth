/**
 * dsh-context-truth — 把「真实的上下文预算」注入给模型，纠正假性「上下文耗尽」判断，并提供手动注入命令。
 *
 * ## 问题
 * 在 DSH 里，量上下文的事只有 `token-meter` 在做，而它的结果只喂 UI 投影
 * （`contextPressure` / `contextBreakdown`），**模型自己收不到任何 token 数字**。
 * 自动压缩（`compaction-basic`）要到 `contextWindow × thresholdRatio` 才动手。
 * 于是阈值以下，模型对「我还剩多少」只能靠猜：历史一长，它就会写出
 * 「上下文即将耗尽 / 我的上下文已经用完」这类无法观测的断言；一旦写进历史，
 * 后续每一轮都会把它当既成事实继续模仿。宿主侧没有纠正它的机制。
 *
 * ## 三条能力
 * 1. **自动事实注入**（`agent/pre-step`）：step 1、每跨 10% 刻度、接近阈值时，
 *    用 `ctx.tokenMeter.measure()`（压缩判定用的同一个数字）+ `session.requestContext().contextWindow`
 *    算出真实百分比与阈值，作为 `source.kind = 'plugin:context-truth'` 的上下文注入。
 * 2. **假性断言更正**：上一条 assistant 消息在低于阈值时声称耗尽 → 补一条更正。
 *    识别是**保守**的：先剥掉代码块/行内代码/引号引用/块引用，再要求
 *    「上下文类断言 + 第一人称 + 停止意图 + 否定语境排除」同时成立。
 *    误判的代价高于漏判 —— 误判会在正常对话里插一条莫名其妙的 Correction。
 * 3. **手动注入命令**：`/context`（别名 `/ctx`）立即把当前余量注入给模型，
 *    用于「模型出现幻觉但自动注入的 10% 刻度还没到」的场景。
 *
 * 零依赖（不 import 任何 `@deepseek-ai/*`）：既能作为 profile bundle 安装，
 * 也能被 `$DSH_HOME/cordis.patch.yml` 以 file:// URL 直接挂载。
 *
 * 同一进程内只允许一个实例真正工作（见 {@link MOUNT_SYMBOL}）。注意：loader 要求
 * **entry id 唯一**，两条同 id 的挂载会在冷启动 `validate` 阶段直接失败
 * （`duplicate loader entry id`），所以「同 id 双挂载」是启动错误，不是运行时仲裁能救的；
 * 运行时的 Symbol 仲裁只用于「不同 id 但同一插件」的重复挂载。
 *
 * 只读：除注入上下文与响应命令外不改任何状态，不改模型输出，不改压缩策略。
 *
 * @module dsh-context-truth
 */

import { randomUUID } from 'node:crypto'

export const name = 'context-truth'

/** token-meter 是宿主 dsh-base bundle 里必然挂载的服务；commands 用于手动注入命令。 */
export const inject = ['tokenMeter', 'commands']

/** 压缩阈值默认值，与 @deepseek-ai/dsh-compaction-basic 的 DEFAULT_THRESHOLD_RATIO 一致。 */
const DEFAULT_THRESHOLD_RATIO = 0.8

/** 低于该容差即判定为「假性耗尽」。 */
const DEFAULT_CLAIM_TOLERANCE = 0.02

/** 同一 turn 内最多更正次数，防止「更正 → 模型复读 → 再更正」自激。 */
const DEFAULT_MAX_CORRECTIONS_PER_TURN = 1

/** 进程级挂载标记：跨模块实例共享（bundle 与 file:// 是两份不同的模块实例）。 */
const MOUNT_SYMBOL = Symbol.for('dsh-context-truth.mount')

/** 扫最近多少条事件找上一条 assistant 消息。 */
const ASSISTANT_SCAN_EVENTS = 200

/** 模型「假性耗尽」陈述的识别（中英文，含 reasoning）。 */
const CLAIM_PATTERNS = [
  /上下文[^。！？\n]{0,24}(耗尽|用完|用尽|快满|即将满|已经满|不够用|告急)/,
  /(我的|本次|这轮|当前)[^。！？\n]{0,12}上下文[^。！？\n]{0,12}(耗尽|用完|用尽)/,
  /(out of context|context (?:is |was )?(?:nearly |almost |basically )?(?:full|exhausted|used up|running out)|running (?:low|out) (?:of )?(?:the |my )?(?:context|tokens?)|low on (?:the |my )?context|context window (?:is |was )?(?:nearly |almost )?full)/i,
]

/** 第一人称自我判断的线索：用于压掉"描述别人/引用"造成的误判。 */
const FIRST_PERSON_HINT = /(我|我的|本会话|本轮|这轮|I |I'm|I am|my |we have)/i

/** 停止意图：真的「因为上下文而停手」时几乎必然出现的措辞。 */
const STOP_INTENT =
  /(不再|不做|不能|无法|没法|停止|停下|中断|交接|收尾|到此为止|结束本轮|留给下一|不继续|先不动|仅做|只做一次|no further|cannot continue|can't continue|must stop|stop here|wrap up|hand(?:ing)? (?:off|over)|handoff|ending this (?:turn|round)|won't continue|will not continue|out of budget)/i

/** 引用/元话语线索：命中就不算模型自己的判断。 */
const QUOTE_HINT = /(不要|别|不用|不信|借口|不是|并非|引用|例如|比如|don't|do not|not an excuse|quote|quoting|e\.g\.|for example)/i

/** 元话语：在"讨论这个检测器/测试用例"时不可避免地会引用这些句子，一律不算自述。 */
const META_HINT = /(claimsContextExhaustion|assert\.(?:equal|match)|selftest|测试用例|回归用例|false positive|误报)/i

/** 一条注入文本的最大长度，避免自己把上下文撑大。 */
const MAX_TEXT_CHARS = 1200

/** 加千分位。 */
function withCommas(value) {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 百分比，保留一位小数；整数值省略小数位。 */
export function percentOf(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return '0'
  const pct = (used / total) * 100
  return pct >= 99.95 ? '100' : (Math.round(pct * 10) / 10).toFixed(1).replace(/\.0$/, '')
}

/** 把注入文本裁到上限，保留最前面的完整句子。 */
function clampText(text) {
  if (text.length <= MAX_TEXT_CHARS) return text
  const cut = text.slice(0, MAX_TEXT_CHARS)
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'))
  return lastStop > MAX_TEXT_CHARS * 0.5 ? cut.slice(0, lastStop + 1) : cut
}

/**
 * 剥掉"不是在陈述自己状态"的片段：围栏代码块、行内代码、成对引号、Markdown 块引用。
 *
 * v1.1.0 的关键修复：v1.0.0 直接在原文上匹配，于是答案里**引用**用户原话
 * （`> 「我的上下文已经用完」`）或代码里的示例字符串都会被当成模型自称，
 * 在正常对话中间插一条 "Correction: … That statement was inaccurate."。
 * @param text - 原始文本。
 * @returns 只保留自述性正文的文本。
 */
export function stripQuoted(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/`[^`\n]{0,300}$/gm, ' ')
    .replace(/"[^"\n]{0,300}"/g, ' ')
    .replace(/“[^”\n]{0,300}”/g, ' ')
    .replace(/「[^」\n]{0,300}」/g, ' ')
    .replace(/『[^』\n]{0,300}』/g, ' ')
    .replace(/‘[^’\n]{0,300}’/g, ' ')
    // ASCII 单引号：只在"像引号的位置"成对剥（前面是行首/空白/左括号/逗号/等号/冒号），
    // 这样不会把 I'm / don't 里的撇号误当引号起点。
    .replace(/(^|[\s（(【[,=:：])'[^'\n]{0,300}'(?=$|[\s）)】\]，。；,;.!?])/gm, '$1 ')
    .replace(/^[ \t]*>[^\n]*$/gm, ' ')
}

/** 取一条消息里模型自己写出的文本（含 reasoning）。 */
function modelTextOf(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) {
    if (block?.type === 'text' || block?.type === 'reasoning') text += String(block.text ?? '')
  }
  return text
}

/**
 * 判定这段模型文本是否真的在声称「我的上下文耗尽」。
 *
 * 保守四条件（全部成立才算）：断言模式命中、第一人称、有停止意图、命中处不是否定/引用语境。
 * 宁可漏判也不误判：误判会在用户眼前插一条无缘无故的 Correction。
 * @param text - 模型输出的正文（含 reasoning）。
 * @returns 是否属于假性耗尽陈述。
 */
export function claimsContextExhaustion(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  const cleaned = stripQuoted(text)
  if (cleaned.trim().length === 0) return false
  // 在讨论检测器/测试用例时，引用这些句子是不可避免的，一律不算自述。
  if (META_HINT.test(text)) return false
  for (const pattern of CLAIM_PATTERNS) {
    const match = pattern.exec(cleaned)
    if (match === null) continue
    const start = Math.max(0, match.index - 60)
    const window = cleaned.slice(start, match.index + match[0].length + 60)
    if (QUOTE_HINT.test(window)) continue
    // 否定语境（"没有耗尽" / "doesn't look exhausted"）
    const gap = cleaned.slice(match.index, match.index + match[0].length)
    if (/(没有|没|未|尚未)/.test(gap)) continue
    if (/(doesn't|does not|isn't|is not|not yet|never)/i.test(window)) continue
    // 第一人称：窗口内或开头 400 字内
    if (!FIRST_PERSON_HINT.test(window) && !FIRST_PERSON_HINT.test(cleaned.slice(0, 400))) continue
    // 停止意图：没有"因此我要停"的措辞，就不是"拿上下文当停止理由"
    if (!STOP_INTENT.test(window)) continue
    return true
  }
  return false
}

/** 取本 turn 内最后一条 assistant 消息的模型文本，没有就返回 undefined。 */
export function lastAssistantModelText(agent, turn) {
  const session = agent?.session
  if (session === undefined || typeof session.seq !== 'number') return undefined
  const floor = Math.max(0, session.seq - ASSISTANT_SCAN_EVENTS)
  for (let seq = session.seq - 1; seq >= floor; seq -= 1) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      return undefined
    }
    if (event === undefined) continue
    if (event.type === 'turn/start' && event.data?.turn !== turn) return undefined
    if (event.type !== 'assistant/message') continue
    if (event.data?.turn !== turn) return undefined
    return modelTextOf(event.data.message)
  }
  return undefined
}

/** 取最近一条 assistant 消息的模型文本（不限定 turn），供手动命令纠正"刚结束那一轮"的说法。 */
export function lastAssistantText(session) {
  if (typeof session?.seq !== 'number') return undefined
  const floor = Math.max(0, session.seq - ASSISTANT_SCAN_EVENTS)
  for (let seq = session.seq - 1; seq >= floor; seq -= 1) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      return undefined
    }
    if (event?.type === 'assistant/message') return modelTextOf(event.data.message)
  }
  return undefined
}

/** 构造一条宿主原生形状的 user 消息（与 createUserMessage 等价，避免跨包 import）。 */
function pluginMessage(text, form = 'snapshot') {
  const body = clampText(text)
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: body }],
    source: {
      kind: `plugin:${name}`,
      form,
      sections: [{ name, text: body }],
    },
  }
}

/** 组装「事实」主体。 */
export function renderBudget(used, window, thresholdRatio) {
  const remaining = Math.max(0, window - used)
  const threshold = Math.floor(window * thresholdRatio)
  const pct = percentOf(used, window)
  const thresholdPct = percentOf(threshold, window)
  const near = used >= threshold
  return [
    `Context budget for this request (measured by the harness token meter, the same figure automatic compaction uses): ~${withCommas(used)} of ${withCommas(window)} tokens used (${pct}%), ~${withCommas(remaining)} remaining.`,
    near
      ? `Compaction threshold ${withCommas(threshold)} (${thresholdPct}%): REACHED — the harness may compact this conversation in this turn.`
      : `Compaction threshold ${withCommas(threshold)} (${thresholdPct}%): not reached, so the context is not near its limit.`,
    'Treat this measurement, not your own estimate, as the truth about remaining context. Do not describe the context as exhausted, nearly exhausted, full, or "about to run out" while the threshold is not reached; if you must stop early, name the concrete blocker instead.',
  ].join('\n')
}

/** 组装「更正」文本。 */
export function renderCorrection(used, window, thresholdRatio) {
  const pct = percentOf(used, window)
  return [
    `[context-truth] Auto-correction: the previous message asserted that the context was exhausted or nearly exhausted, and used that as a reason to stop. The harness measures ~${withCommas(used)} of ${withCommas(window)} tokens (${pct}%), below the compaction threshold of ${percentOf(Math.floor(window * thresholdRatio), window)}%.`,
    'That assertion was inaccurate. Continue the task from where it stopped; if you must stop, name the concrete blocker instead of context capacity.',
  ].join('\n')
}

/** 命令结果里的中文摘要（给人看，不进模型上下文）。 */
export function renderCommandSummary(used, window, thresholdRatio, delivery, corrected) {
  const remaining = Math.max(0, window - used)
  const threshold = Math.floor(window * thresholdRatio)
  const pct = percentOf(used, window)
  const where =
    delivery === 'next-step'
      ? '已注入：本轮下一步'
      : delivery === 'turn'
        ? '已注入：作为下一轮的上下文（已排队）'
        : '已挂起：下一次请求时注入'
  const tail = corrected ? '；并附了一条「假性耗尽」更正' : ''
  return `上下文 ~${withCommas(used)} / ${withCommas(window)}（${pct}%），余量 ~${withCommas(remaining)}；压缩阈值 ${withCommas(threshold)}（${percentOf(threshold, window)}%）。${where}${tail}。`
}

/**
 * 把一条注入消息送达模型：优先贴合当前 agent 状态，失败则退化为「下一次请求时注入」。
 * @param agent - 目标 agent。
 * @param message - 已构造好的 user 消息。
 * @param mode - `auto`（按状态选择）/ `turn`（强制开一轮）/ `queue`（不主动送达）。
 * @returns 实际采用的送达方式，或 `'flag'` 表示已挂起等待下一次 pre-step。
 */
export function deliverInjection(agent, message, mode) {
  if (mode === 'queue') return 'flag'
  const nextStep = {
    name: 'next-step',
    run: () => {
      if (typeof agent?.inbox?.prepend !== 'function') return false
      agent.inbox.prepend('next-step', message)
      return true
    },
  }
  const turn = {
    name: 'turn',
    run: () => {
      if (typeof agent?.followup !== 'function') return false
      agent.followup(message)
      return true
    },
  }
  const running = agent?.status === 'running'
  const order = mode === 'turn' ? [turn, nextStep] : running ? [nextStep, turn] : [turn, nextStep]
  for (const path of order) {
    try {
      if (path.run()) return path.name
    } catch {
      /* 换下一条路 */
    }
  }
  return 'flag'
}

/** 读取并校验数字型配置。 */
function ratioFrom(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  if (globalThis[MOUNT_SYMBOL] !== undefined && config.allowMultipleMounts !== true) {
    ctx.logger?.warn?.(
      'context-truth: already mounted in this process — this instance stands down ' +
        '(a duplicate entry must use a different loader entry id; identical ids fail at load time)',
    )
    return
  }
  globalThis[MOUNT_SYMBOL] = true
  ctx.effect?.(() => () => {
    if (globalThis[MOUNT_SYMBOL] === true) globalThis[MOUNT_SYMBOL] = undefined
  })

  const configuredRatio = ratioFrom(config.thresholdRatio, undefined)
  const claimTolerance =
    typeof config.claimTolerance === 'number' && config.claimTolerance >= 0 && config.claimTolerance < 1
      ? config.claimTolerance
      : DEFAULT_CLAIM_TOLERANCE
  const correctionsEnabled = config.corrections !== false
  const maxCorrections =
    Number.isSafeInteger(config.maxCorrectionsPerTurn) && config.maxCorrectionsPerTurn >= 0
      ? config.maxCorrectionsPerTurn
      : DEFAULT_MAX_CORRECTIONS_PER_TURN
  const commandMode =
    config.commandMode === 'turn' || config.commandMode === 'queue' || config.commandMode === 'auto'
      ? config.commandMode
      : 'auto'
  const commandNames =
    config.commandName === false
      ? []
      : [
          ...new Set(
            [typeof config.commandName === 'string' ? config.commandName : 'context']
              .concat(Array.isArray(config.commandAliases) ? config.commandAliases : ['ctx'])
              .filter((item) => typeof item === 'string' && /^[a-z][a-z0-9_-]*$/u.test(item)),
          ),
        ]

  /** 读取用户设置的压缩阈值（$DSH_HOME/settings.yaml 的 compaction.thresholdRatio）。 */
  const liveThresholdRatio = () => {
    try {
      const settings = ctx.get?.('settings')
      const ratio = settings?.get?.('compaction')?.thresholdRatio ?? settings?.document?.compaction?.thresholdRatio
      if (typeof ratio === 'number' && ratio > 0 && ratio <= 1) return ratio
    } catch {}
    return configuredRatio ?? DEFAULT_THRESHOLD_RATIO
  }

  /** 每会话状态：上次注入的百分比、本 turn 更正次数、手动注入挂起数。 */
  const states = new Map()
  const stateOf = (sessionId) => {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = { lastPercent: -1, lastTurn: -1, corrections: 0, forced: 0 }
      states.set(sessionId, state)
      if (states.size > 500) states.delete(states.keys().next().value)
    }
    return state
  }

  /** 现算一次用量；拿不到窗口或用量就返回 undefined。 */
  const measure = (session) => {
    const window = session?.requestContext?.()?.contextWindow
    if (!Number.isInteger(window) || window <= 0) return undefined
    const used = ctx.tokenMeter.measure(session).totalTokens
    if (!Number.isFinite(used) || used < 0) return undefined
    return { window, used }
  }

  // ---- 手动注入命令 -------------------------------------------------------
  if (commandNames.length > 0 && typeof ctx.commands?.register === 'function') {
    const handler = async (invocation) => {
      const agent = invocation?.agent
      const session = agent?.session
      if (session === undefined) return { kind: 'error', text: '没有可用的会话。' }

      // `/context queue` / `/context turn` 可按次覆盖默认送达方式。
      const argument = String(invocation?.rawInput ?? '').trim().toLowerCase()
      let mode = commandMode
      if (argument === 'queue' || argument === 'flag') mode = 'queue'
      else if (argument === 'turn' || argument === 'now') mode = 'turn'
      else if (argument !== '' && argument !== 'auto' && argument !== 'inject') {
        return { kind: 'error', text: '用法：/context [queue|turn]（默认 auto）' }
      }

      let measured
      try {
        measured = measure(session)
      } catch (error) {
        return { kind: 'error', text: `上下文测量失败：${String(error?.message ?? error)}` }
      }
      if (measured === undefined) {
        return { kind: 'error', text: '当前会话还没有上报上下文窗口（先发一条消息产生一次请求后再试）。' }
      }

      const ratio = liveThresholdRatio()
      const { window, used } = measured
      const corrected =
        correctionsEnabled && used / window < ratio - claimTolerance && claimsContextExhaustion(lastAssistantText(session))
      const parts = [renderBudget(used, window, ratio)]
      if (corrected) parts.push(renderCorrection(used, window, ratio))

      let delivery
      try {
        delivery = deliverInjection(agent, pluginMessage(parts.join('\n\n'), 'manual'), mode)
      } catch {
        delivery = 'flag'
      }
      const state = stateOf(session.id ?? agent.id ?? 'unknown')
      if (delivery === 'flag') state.forced += 1
      return {
        kind: 'success',
        text: renderCommandSummary(used, window, ratio, delivery, corrected),
      }
    }

    ctx.effect(() => {
      const disposers = []
      for (const commandName of commandNames) {
        try {
          disposers.push(
            ctx.commands.register({
              name: commandName,
              description: '立即把当前上下文余量注入给模型（默认 auto：运行中→下一步，空闲→下一轮）',
              handler,
            }),
          )
        } catch (error) {
          ctx.logger?.warn?.(`context-truth: could not register /${commandName}: ${String(error?.message ?? error)}`)
        }
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {}
        }
      }
    })
  }

  // ---- 每步自动注入 + 假性耗尽更正 ---------------------------------------
  ctx.on(
    'agent/pre-step',
    async ({ agent, turn, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal?.aborted) return decision
      const session = agent?.session
      if (session === undefined) return decision

      let measured
      try {
        measured = measure(session)
      } catch (error) {
        ctx.logger?.warn?.(`context-truth: measurement skipped: ${String(error?.message ?? error)}`)
        return decision
      }
      if (measured === undefined) return decision
      const { window, used } = measured

      const state = stateOf(session.id ?? agent.id ?? 'unknown')
      if (state.lastTurn !== turn) {
        state.lastTurn = turn
        state.corrections = 0
      }

      const thresholdRatio = liveThresholdRatio()
      const pct = Math.round((used / window) * 1000) / 10
      const ratio = used / window
      const belowThreshold = ratio < thresholdRatio - claimTolerance
      const injected = []

      if (correctionsEnabled && belowThreshold && state.corrections < maxCorrections) {
        const previous = lastAssistantModelText(agent, turn)
        if (claimsContextExhaustion(previous)) {
          injected.push(renderCorrection(used, window, thresholdRatio))
          state.corrections += 1
        }
      }

      // 手动命令挂起时，无论刻度是否跨过都注入一次。
      const forced = state.forced > 0
      if (forced) state.forced -= 1
      const crossed = state.lastPercent < 0 || Math.floor(pct / 10) > Math.floor(state.lastPercent / 10)
      if (forced || crossed || ratio >= thresholdRatio - 0.05) {
        injected.push(renderBudget(used, window, thresholdRatio))
        state.lastPercent = pct
      }

      if (injected.length === 0) return decision
      return {
        ...decision,
        messages: [...decision.messages, ...injected.map((text) => pluginMessage(text))],
      }
    },
    { prepend: true },
  )
}

export default { name, inject, apply }
