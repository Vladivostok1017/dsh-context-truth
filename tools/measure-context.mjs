/**
 * 取证工具：读一个 DSH 会话日志（session.v3.jsonl.zstd，支持多 zstd frame 追加），
 * 打印每一步的 prompt 用量 / 窗口百分比 / 压缩事件，用来核对「模型声称耗尽」时
 * 的真实用量。
 *
 * 用法：
 *   node tools/measure-context.mjs "C:\...\sessions\--F-dsh--\session-xxxx\session.v3.jsonl.zstd"
 *   node tools/measure-context.mjs <path> --all     # 打印全部 step，而不是抽样 30 行
 */

import fs from 'node:fs'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 逐帧解压（DSH 的日志是 append-only，每次 flush 追加一个独立 zstd frame）。 */
export function decodeSession(file) {
  const buf = fs.readFileSync(file)
  const starts = []
  let i = 0
  while (i < buf.length - 4) {
    const j = buf.indexOf(MAGIC, i)
    if (j === -1) break
    starts.push(j)
    i = j + 4
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    try {
      text += zlib.zstdDecompressSync(slice).toString('utf8')
    } catch {
      /* 尾部半截 frame 忽略 */
    }
  }
  return { text, frames: starts.length }
}

function main() {
  const file = process.argv[2]
  if (file === undefined) {
    console.error('用法: node tools/measure-context.mjs <session.v3.jsonl.zstd> [--all]')
    process.exit(2)
  }
  const showAll = process.argv.includes('--all')
  const { text, frames } = decodeSession(file)

  let window
  const steps = []
  const compactions = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const data = event.data ?? {}
    if (event.type === 'request/context' && data.contextWindow !== undefined) window = data.contextWindow
    if (event.type === 'assistant/message' && data.usage !== undefined) {
      const usage = data.usage
      const prompt =
        usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      steps.push({ turn: data.turn, step: data.step, prompt, output: usage.outputTokens })
    }
    if (typeof event.type === 'string' && event.type.startsWith('compaction/')) {
      compactions.push({ type: event.type, seq: event.seq })
    }
  }

  console.log(`frames=${frames} events=${text.split('\n').length - 1} steps=${steps.length}`)
  console.log(`contextWindow=${window ?? '(未上报)'}  压缩事件=${compactions.length}`)
  if (window === undefined || steps.length === 0) return

  const peak = steps.reduce((a, b) => (b.prompt > a.prompt ? b : a), steps[0])
  const every = Math.max(1, Math.round(steps.length / 30))
  for (let i = 0; i < steps.length; i += 1) {
    if (!showAll && i % every !== 0 && i !== steps.length - 1) continue
    const s = steps[i]
    const pct = ((s.prompt / window) * 100).toFixed(1)
    console.log(`turn=${s.turn} step=${s.step} prompt=${s.prompt} (${pct}%) out=${s.output}`)
  }
  console.log(
    `PEAK prompt=${peak.prompt} (${((peak.prompt / window) * 100).toFixed(1)}%) at turn ${peak.turn}`,
  )
  const threshold = Math.floor(window * 0.8)
  console.log(
    `80% 压缩阈值=${threshold}  ${peak.prompt < threshold ? '峰值未达阈值 → 从未需要压缩' : '峰值已越过阈值'}`,
  )
}

main()
