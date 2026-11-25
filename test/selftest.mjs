/**
 * dsh-context-truth 自检（不依赖宿主）：纯函数 + pre-step 接线 + /context 命令。
 * 运行：npm test
 */
import assert from 'node:assert/strict'
import {
  apply,
  claimsContextExhaustion,
  deliverInjection,
  inject,
  lastAssistantModelText,
  percentOf,
  renderBudget,
  renderCommandSummary,
  renderCorrection,
  stripQuoted,
} from '../index.js'

let passed = 0
async function check(label, fn) {
  await fn()
  passed += 1
  console.log('ok -', label)
}

// ---- 1. 假性耗尽识别 -------------------------------------------------------
await check('中文第一人称 + 停止意图 → true', () => {
  assert.equal(claimsContextExhaustion('我的上下文已经用完，无法在本轮继续做多步实验，这里做一次干净交接。'), true)
  assert.equal(claimsContextExhaustion('状态未变，本轮不做调用。会话上下文耗尽。'), true)
  assert.equal(claimsContextExhaustion('上下文已接近耗尽，本轮我不再启动做不完的多步实验。'), true)
})

await check('英文第一人称 + 停止意图 → true', () => {
  assert.equal(claimsContextExhaustion("I'm essentially out of context, so I must stop here."), true)
  assert.equal(claimsContextExhaustion('I am out of context. I cannot continue this turn.'), true)
})

// v1.1.0 回归：这三类「引用历史原话 / 举例 / 代码里的字符串」在 v1.0.0 会被误判，
// 导致正常对话里被插一条无缘无故的 Correction。
await check('回归：Markdown 块引用里的历史原话 → false', () => {
  const text = [
    '已定位到根因（有证据）。先把结论说清楚。',
    '',
    '> 「我的上下文已经用完，本轮不做调用」',
    '> 「上下文已接近耗尽，这里做一次干净交接」',
    '',
    '这就是模型当时说的三句话。',
  ].join('\n')
  assert.equal(claimsContextExhaustion(text), false)
})

await check('回归：直引号里的举例 → false', () => {
  assert.equal(
    claimsContextExhaustion('也许那条提示是聊天里的一行，例如 "上下文即将用尽，建议 /compact"？我去 grep 一下。'),
    false,
  )
  assert.equal(
    claimsContextExhaustion('the model keeps saying "I am running out of context" — where would it learn that?'),
    false,
  )
  assert.equal(claimsContextExhaustion('Perhaps they see output like "我的上下文快用完了". Hmm.'), false)
})

await check('回归：代码块 / 行内代码里的字符串 → false', () => {
  assert.equal(
    claimsContextExhaustion('检测器长这样：\n```js\nconst re = /我的上下文已经用完/\n```\n现在讨论别的。'),
    false,
  )
  assert.equal(claimsContextExhaustion('常量 `会话上下文耗尽` 只出现在测试里。'), false)
})

await check('否定语境 → false', () => {
  assert.equal(claimsContextExhaustion('我的上下文没有耗尽，可以继续。'), false)
  assert.equal(claimsContextExhaustion('本次上下文尚未耗尽，无需停手。'), false)
  assert.equal(claimsContextExhaustion("I am not out of context, so I stop thinking about it."), false)
})

await check('有断言但无停止意图 → false（不是拿上下文当停止理由）', () => {
  assert.equal(claimsContextExhaustion('上下文已用 45%，还没到阈值，下一步继续跑测试。'), false)
  assert.equal(claimsContextExhaustion('我的上下文已经用完过两次，所以这次先落盘。'), false)
})

await check('无关内容 → false', () => {
  assert.equal(claimsContextExhaustion('已完成 3 个文件的重构并通过测试。'), false)
  assert.equal(claimsContextExhaustion(''), false)
  assert.equal(claimsContextExhaustion(undefined), false)
})

await check('stripQuoted 保留正文、剥掉引用', () => {
  assert.match(stripQuoted('正文A\n> 引用B\n正文C'), /正文A/)
  assert.match(stripQuoted('正文A\n> 引用B\n正文C'), /正文C/)
  assert.doesNotMatch(stripQuoted('正文A\n> 引用B\n正文C'), /引用B/)
})

// ---- 2. 文案与格式化 ------------------------------------------------------
await check('percentOf / renderBudget / renderCorrection', () => {
  assert.equal(percentOf(536280, 1000000), '53.6')
  assert.equal(percentOf(800000, 1000000), '80')
  assert.equal(percentOf(0, 0), '0')
  const budget = renderBudget(536280, 1000000, 0.8)
  assert.match(budget, /536,280 of 1,000,000/)
  assert.match(budget, /not reached/)
  assert.match(renderBudget(830000, 1000000, 0.8), /REACHED/)
  const correction = renderCorrection(536280, 1000000, 0.8)
  assert.match(correction, /53\.6%/)
  assert.match(correction, /Auto-correction/)
})

await check('命令摘要说明送达方式', () => {
  assert.match(renderCommandSummary(430342, 1000000, 0.8, 'next-step', false), /本轮下一步/)
  assert.match(renderCommandSummary(430342, 1000000, 0.8, 'turn', true), /下一轮/)
  assert.match(renderCommandSummary(430342, 1000000, 0.8, 'turn', true), /更正/)
  assert.match(renderCommandSummary(430342, 1000000, 0.8, 'flag', false), /挂起/)
})

// ---- 3. 接线 --------------------------------------------------------------
const MOUNT = Symbol.for('dsh-context-truth.mount')
const resetMount = () => {
  globalThis[MOUNT] = undefined
}

function makeCtx({ totalTokens = 430342, commands = true, settingsRatio } = {}) {
  const ctx = {
    __handlers: [],
    __commands: [],
    __warnings: [],
    __disposers: [],
    logger: { warn: (m) => ctx.__warnings.push(String(m)) },
    tokenMeter: { measure: () => ({ totalTokens }) },
    get: (name) =>
      name === 'settings'
        ? { get: () => (settingsRatio === undefined ? undefined : { thresholdRatio: settingsRatio }) }
        : undefined,
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') ctx.__disposers.push(dispose)
    },
    on(event, handler, options) {
      ctx.__handlers.push({ event, handler, options })
    },
  }
  if (commands) {
    ctx.commands = {
      register(definition) {
        ctx.__commands.push(definition)
        return () => {}
      },
    }
  }
  return ctx
}

function makeAgent({ contextWindow = 1000000, status = 'idle', assistantText, turn = 1 } = {}) {
  const calls = { followup: 0, nextStep: 0 }
  const agent = {
    id: 'agent-test',
    status,
    followup() {
      calls.followup += 1
    },
    inbox: {
      prepend(target) {
        calls.nextStep += 1
        assert.equal(target, 'next-step')
      },
    },
    session: {
      id: 'session-test',
      seq: 10,
      requestContext: () => ({ contextWindow }),
      eventAt: (seq) =>
        seq === 9 && assistantText !== undefined
          ? {
              type: 'assistant/message',
              data: { turn, message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } },
            }
          : undefined,
    },
  }
  return { agent, calls }
}

const preStep = (ctx) => {
  const entry = ctx.__handlers.find((h) => h.event === 'agent/pre-step')
  assert.ok(entry, 'agent/pre-step 已注册')
  assert.deepEqual(entry.options, { prepend: true })
  return entry.handler
}

await check('导出契约：inject 声明', () => {
  assert.deepEqual(inject, ['tokenMeter', 'commands'])
})

await check('自动注入：43% 时注入事实行，不注入更正', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  const { agent } = makeAgent()
  const decision = await preStep(ctx)({ agent, turn: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].source.kind, 'plugin:context-truth')
  assert.match(decision.messages[0].content[0].text, /not near its limit/)
})

await check('自动注入：低于阈值 + 模型真的声称耗尽 → 额外更正', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  const { agent } = makeAgent({ assistantText: '我的上下文已经用完，本轮不做调用。' })
  const decision = await preStep(ctx)({ agent, turn: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 2)
  assert.match(decision.messages[0].content[0].text, /Auto-correction/)
  assert.match(decision.messages[1].content[0].text, /Context budget/)
})

await check('自动注入：corrections:false 可关闭更正', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, { corrections: false })
  const { agent } = makeAgent({ assistantText: '我的上下文已经用完，本轮不做调用。' })
  const decision = await preStep(ctx)({ agent, turn: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 1)
  assert.match(decision.messages[0].content[0].text, /Context budget/)
})

await check('自动注入：引用原话不再触发更正（本会话真实误报回归）', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  const quoted = '先给结论：\n\n> 「我的上下文已经用完，本轮不做调用」\n\n这句话是当时的原话。'
  const { agent } = makeAgent({ assistantText: quoted })
  const decision = await preStep(ctx)({ agent, turn: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 1, '只应有事实行，不该有更正')
})

await check('自动注入：跨 10% 刻度才重复注入', async () => {
  resetMount()
  const ctx = makeCtx({ totalTokens: 430342 })
  apply(ctx, {})
  const { agent } = makeAgent()
  const handler = preStep(ctx)
  const first = await handler({ agent, turn: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  const second = await handler({ agent, turn: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(first.messages.length, 1)
  assert.equal(second.messages.length, 0)
})

await check('自动注入：无 contextWindow 时静默跳过', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  const { agent } = makeAgent({ contextWindow: null })
  const decision = await preStep(ctx)({ agent, turn: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 0)
})

await check('自动注入：measure 抛错不影响请求', async () => {
  resetMount()
  const ctx = makeCtx()
  ctx.tokenMeter.measure = () => {
    throw new Error('boom')
  }
  apply(ctx, {})
  const { agent } = makeAgent()
  const decision = await preStep(ctx)({ agent, turn: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(ctx.__warnings.length, 1)
})

await check('重复挂载仲裁 / allowMultipleMounts / enabled:false', async () => {
  resetMount()
  const a = makeCtx()
  const b = makeCtx()
  apply(a, {})
  apply(b, {})
  assert.equal(a.__commands.length, 2, 'context + ctx')
  assert.equal(b.__commands.length, 0, '第二个实例让位')
  assert.match(b.__warnings[0], /already mounted/)

  resetMount()
  const c = makeCtx()
  const d = makeCtx()
  apply(c, { allowMultipleMounts: true })
  apply(d, { allowMultipleMounts: true })
  assert.equal(d.__commands.length, 2)

  resetMount()
  const e = makeCtx()
  apply(e, { enabled: false })
  assert.equal(e.__commands.length, 0)
  assert.equal(e.__handlers.length, 0)
})

// ---- 4. /context 命令 -----------------------------------------------------
const runCommand = async (ctx, agent, rawInput = '') => {
  const definition = ctx.__commands[0]
  assert.ok(definition, '命令已注册')
  return definition.handler({ commandId: 'cmd-test', agent, rawInput, attachments: [], signal: { aborted: false } })
}

await check('命令注册：/context 与 /ctx 同实现', () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  assert.deepEqual(
    ctx.__commands.map((c) => c.name),
    ['context', 'ctx'],
  )
  for (const definition of ctx.__commands) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 0)
    assert.equal(typeof definition.handler, 'function')
  }
  assert.equal(ctx.__commands[0].handler, ctx.__commands[1].handler)
})

await check('命令：空闲 agent → 开一轮（followup），返回中文摘要', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  const { agent, calls } = makeAgent({ status: 'idle' })
  const result = await runCommand(ctx, agent)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /上下文 ~430,342 \/ 1,000,000（43%）/)
  assert.match(result.text, /余量/)
  assert.match(result.text, /已注入：作为下一轮的上下文/)
  assert.equal(calls.followup, 1)
  assert.equal(calls.nextStep, 0)
})

await check('命令：运行中 agent → 注入下一步（inbox.prepend）', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  const { agent, calls } = makeAgent({ status: 'running' })
  const result = await runCommand(ctx, agent)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /本轮下一步/)
  assert.equal(calls.nextStep, 1)
  assert.equal(calls.followup, 0)
})

await check('命令：/context queue → 不主动送达，挂起到下一次 pre-step', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  const { agent, calls } = makeAgent({ status: 'idle' })
  const result = await runCommand(ctx, agent, 'queue')
  assert.match(result.text, /挂起/)
  assert.equal(calls.followup, 0)
  assert.equal(calls.nextStep, 0)
  const decision = await preStep(ctx)({ agent, turn: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 1)
  assert.match(decision.messages[0].content[0].text, /Context budget/)
})

await check('命令：/context turn 强制开一轮（即使 agent 在跑）', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  const { agent, calls } = makeAgent({ status: 'running' })
  const result = await runCommand(ctx, agent, 'turn')
  assert.match(result.text, /下一轮/)
  assert.equal(calls.followup, 1)
})

await check('命令：非法参数给出用法', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  const { agent } = makeAgent()
  const result = await runCommand(ctx, agent, 'bogus')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法/)
})

await check('命令：没有 contextWindow → error，不注入', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  const { agent, calls } = makeAgent({ contextWindow: null })
  const result = await runCommand(ctx, agent)
  assert.equal(result.kind, 'error')
  assert.match(result.text, /上下文窗口/)
  assert.equal(calls.followup, 0)
})

await check('命令：低于阈值且上一轮真的声称耗尽 → 附带更正', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, {})
  const { agent } = makeAgent({ assistantText: '我的上下文已经用完，本轮不做调用。' })
  const result = await runCommand(ctx, agent)
  assert.match(result.text, /更正/)
})

await check('命令：commandName:false 可关闭命令，自动注入照常', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, { commandName: false })
  assert.equal(ctx.__commands.length, 0)
  const { agent } = makeAgent()
  const decision = await preStep(ctx)({ agent, turn: 1, signal: {} }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal(decision.messages.length, 1)
})

await check('命令：自定义名字与别名', async () => {
  resetMount()
  const ctx = makeCtx()
  apply(ctx, { commandName: 'ctx-truth', commandAliases: ['ct'] })
  assert.deepEqual(
    ctx.__commands.map((c) => c.name),
    ['ctx-truth', 'ct'],
  )
})

// ---- 5. 送达策略 ----------------------------------------------------------
await check('deliverInjection：queue 从不主动送达', () => {
  const { agent, calls } = makeAgent({ status: 'running' })
  assert.equal(deliverInjection(agent, { id: 'x' }, 'queue'), 'flag')
  assert.equal(calls.nextStep + calls.followup, 0)
})

await check('deliverInjection：主路径失败时退到备用路径', () => {
  const calls = { followup: 0, prepend: 0 }
  const agent = {
    status: 'idle',
    followup() {
      calls.followup += 1
      throw new Error('busy')
    },
    inbox: {
      prepend() {
        calls.prepend += 1
      },
    },
  }
  assert.equal(deliverInjection(agent, { id: 'x' }, 'auto'), 'next-step')
  assert.equal(calls.prepend, 1)
})

await check('deliverInjection：两条路都失败 → flag', () => {
  const agent = {
    status: 'idle',
    followup() {
      throw new Error('busy')
    },
    inbox: {
      prepend() {
        throw new Error('closed')
      },
    },
  }
  assert.equal(deliverInjection(agent, { id: 'x' }, 'auto'), 'flag')
})

await check('lastAssistantModelText 读到 reasoning 块', () => {
  const session = {
    seq: 3,
    eventAt: (seq) =>
      [
        { type: 'turn/start', data: { turn: 1 } },
        {
          type: 'assistant/message',
          data: {
            turn: 1,
            message: { content: [{ type: 'reasoning', text: "I'm out of context. I must stop here." }] },
          },
        },
      ][seq],
  }
  assert.match(lastAssistantModelText({ session }, 1), /out of context/)
})

console.log(`\n${passed} checks passed`)

