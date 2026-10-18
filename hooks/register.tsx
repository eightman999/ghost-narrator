import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Stage } from '../types'
import {
  type Beat,
  type Kind,
  IPC_JXA,
  URGENT,
  aiPrompt,
  aiScript,
  basename,
  buildSend,
  LISTENER_PY,
  parseListener,
  permissionScript,
  permissionSummary,
  type PermissionDecision,
  LINKED,
  sessionLink,
  withSessionChoice,
  faceFor,
  isCheckCommand,
  parseStatus,
  plainText,
  pngSize,
  shellSvg,
  templateLine,
} from './sstp'

// 頻出イベント（edit/run/prompt）の最短間隔（tick 単位。500ms × 12 = 6秒）
const TICK_MS = 500
const QUIET_TICKS = 12
const PANE = 'ghost'
const stage = atom({ plugin: 'ghost-narrator', key: 'stage' } as const, { kind: 'start', line: '', at: 0 } as Stage)

type Png = { b64: string; w: number; h: number }

export const register: Register = (on, options) => {
  const endpoint = String(options.endpoint ?? 'http://127.0.0.1:9801/api/sstp/v1')
  const receiver = String(options.receiver ?? '') || undefined
  const voice = String(options.voice ?? 'template')
  // auto: HTTP を試し、失敗したら Ourin の Distributed IPC（osascript）へ
  const transport = String(options.transport ?? 'auto')
  const linkEnabled = options.sessionLink !== false
  // 許可待ちをバルーンのボタンで答えられるようにする（ask の時だけ）
  const permissionBalloon = options.permissionBalloon !== false
  const PERMISSION_TIMEOUT_SEC = 90
  // 許可バルーン表示中は実況でバルーンを上書きしない
  let permissionPending = false
  // デスクトップアプリのセッションへ戻るリンク（session.start で決まる）
  let link: string | undefined

  // 重要イベントは順に、頻出イベントは最新1件だけ保持
  const urgent: Beat[] = []
  let casual: Beat | undefined
  let tick = 0
  let lastSpokeAt = -QUIET_TICKS
  let busy = false
  let muted = false
  let lastResult = '未送信'
  // Ourin 不通時は送信を一定時間休む（ペインは更新し続ける）
  let retryAt = 0
  const RETRY_TICKS = 60
  // ペインに描くシェル画像（session.start で読む。読めなければペインは台詞だけ）
  const images = new Map<string, Png>()

  const enqueue = (kind: Kind, detail = ''): void => {
    if (muted && kind !== 'say') return
    const beat = { kind, detail }
    if (URGENT.has(kind)) {
      if (urgent.length < 8) urgent.push(beat)
    } else {
      casual = beat
    }
  }

  const take = (): Beat | undefined => {
    const beat = urgent.shift()
    if (beat) return beat
    if (casual && tick - lastSpokeAt >= QUIET_TICKS) {
      const c = casual
      casual = undefined
      return c
    }
    return undefined
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ghost',
      description: 'ゴースト実況: /ghost say <text> | pane | test | mute | unmute | status',
    })

    // シェル画像を読み込む（Ourin 不要で Claude のペインに描くため）
    const shellDir = String(options.shellDir ?? '') || `${(await $.env.get('HOME')) ?? ''}/Documents/Ourin/ghost/emily4/shell/master`
    for (const name of ['surface0000.png', 'element0003.png', 'element0005.png', 'element0021.png']) {
      try {
        const { base64 } = await $.fs.read(`${shellDir}/${name}`, { as: 'bytes' })
        const size = pngSize(base64)
        if (size) images.set(name, { b64: base64, ...size })
      } catch {
        // 無いパーツは表情なしで描く
      }
    }
    void $.ui.open({ id: PANE, title: 'Ghost' })
    if (linkEnabled) link = sessionLink(await $.env.get('CLAUDE_CODE_HOST_SESSION_ID'))

    // 送信はタイマー側で行い、ツール実行を待たせない
    $.clock.every(TICK_MS, () => {
      tick++
      if (busy || permissionPending) return
      const beat = take()
      if (!beat) return
      busy = true
      void (async () => {
        try {
          let script = templateLine(beat)
          if (voice === 'ai' && beat.kind !== 'say') {
            const r = await $.model.complete({ model: 'haiku', prompt: aiPrompt(beat), maxTokens: 80, timeoutMs: 4000 })
            if (r.isAnswered && r.text.trim()) script = aiScript(beat, r.text)
          }
          // ペイン（Claude 内のゴースト）は Ourin の有無に関係なく更新する
          await update($, stage, () => ({ kind: beat.kind, line: plainText(script), at: tick }))
          lastSpokeAt = tick
          if (tick < retryAt) return
          // ペインは Claude の中なのでリンク不要。Ourin のバルーンにだけ付ける
          const balloon = link && LINKED.has(beat.kind) ? withSessionChoice(script, link) : script
          const body = buildSend(beat, balloon, { receiver })
          let status: number | undefined
          if (transport !== 'ipc') {
            try {
              const res = await $.http.fetch(endpoint, {
                method: 'POST',
                // Origin を付けるとブラウザ由来＝外部扱いで 420 Refuse になる（ローカルツールなので付けない）
                headers: { 'Content-Type': 'text/plain' },
                body,
              })
              // SSTP 応答行が返った時だけ成功扱い（HTTP 4xx/5xx は IPC へ）
              status = parseStatus(res.text)
              if (status === undefined && transport === 'http') throw new Error(`HTTP ${res.status}`)
            } catch (err) {
              if (transport === 'http') throw err
            }
          }
          if (status === undefined) {
            const r = await $.process.run(['osascript', '-l', 'JavaScript', '-e', IPC_JXA], { stdin: body, timeoutMs: 5000 })
            status = r.exitCode === 0 ? parseStatus(r.stdout) : undefined
            if (status === undefined) throw new Error(r.stderr || 'ipc failed')
          }
          if (lastResult.startsWith('NG')) $.ui.toast(`ghost-narrator: 接続復帰（SSTP ${status}）`)
          lastResult = `OK ${status}`
        } catch {
          // Ourin 未起動。最初の1回だけ知らせ、しばらく送信を休む（ペイン側の実況は続く）
          if (!lastResult.startsWith('NG')) $.ui.toast(`ghost-narrator: Ourin に届かない（ペインでの実況は継続）`)
          lastResult = 'NG unreachable'
          retryAt = tick + RETRY_TICKS
        } finally {
          busy = false
        }
      })()
    })

    enqueue('start')
    return next(e)
  })

  on('command.run', { command: 'ghost' }, async (_$, e) => {
    const args = e.args.trim()
    const [sub = 'status'] = args.split(/\s+/)
    const rest = args.slice(sub.length).trim()
    switch (sub) {
      case 'say':
        if (!rest) return { text: '使い方: /ghost say <text>' }
        enqueue('say', rest)
        return { text: `ゴーストへ送信予約: ${rest}` }
      case 'test':
        enqueue('say', 'テスト送信だよ。聞こえてる？')
        return { text: `テスト送信を予約 → ${endpoint}（結果は /ghost status）` }
      case 'pane':
        await _$.ui.open({ id: PANE, title: 'Ghost', focus: true })
        return { text: 'ゴーストのペインを開きました' }
      case 'mute':
        muted = true
        urgent.length = 0
        casual = undefined
        return { text: 'ゴースト実況: ミュート' }
      case 'unmute':
        muted = false
        return { text: 'ゴースト実況: 再開' }
      default:
        return {
          text: `ghost-narrator: ${muted ? 'ミュート中' : '実況中'} / voice=${voice} / transport=${transport} / endpoint=${endpoint} / 直近=${lastResult}`,
        }
    }
  })

  on('prompt.submit', (_$, e, next) => {
    if (!e.text.startsWith('/')) enqueue('prompt', e.text)
    return next(e)
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async (_$, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined) enqueue('denied', r.deny)
    else if (!r.isError) enqueue('edit', basename(e.file_path))
    return r
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async (_$, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined) enqueue('denied', r.deny)
    else if (!r.isError) enqueue('edit', basename(e.file_path))
    return r
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async (_$, e, next) => {
    const r = await next(e)
    const cmd = e.command.trim()
    if (r.deny !== undefined) enqueue('denied', r.deny)
    else if (isCheckCommand(cmd)) enqueue(r.isError ? 'fail' : 'pass', cmd)
    else if (r.isError) enqueue('fail', cmd)
    else enqueue('run', cmd.split(/\s+/)[0] ?? cmd)
    return r
  }).catch((_$, e, next) => next(e))

  on('turn.complete', (_$, e, next) => {
    enqueue(e.isAborted || e.reason === 'aborted' ? 'aborted' : 'done', e.answer.slice(0, 80))
    return next(e)
  })

  // Claude のウィンドウ内に描くゴースト：シェル + 表情パーツ（SVG）とバルーン
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const now = await read($, stage)
    const base = images.get('surface0000.png')
    const faceName = faceFor(now.kind)
    const face = faceName ? images.get(faceName) : undefined
    const line = now.line || '…'
    const svg =
      base && 'Svg' in ui
        ? shellSvg(base, face && { b64: face.b64, x: 85, y: 80, w: face.w, h: face.h })
        : undefined
    const Svg = 'Svg' in ui ? ui.Svg : undefined
    return (
      <Box flexDirection="column" gap={1}>
        <Box borderStyle="round" paddingX={1}>
          <Text>{line}</Text>
        </Box>
        {Svg && svg ? <Svg source={svg} alt={`ゴースト（${now.kind}）`} width={200} /> : <Text dimColor>（シェル画像なし）</Text>}
      </Box>
    )
  })

  // 許可が必要な時は、ゴーストのバルーンに「許可・セッション表示・拒否」を出して答えを待つ。
  // 押されたボタンは Ourin の \![execute,http-get] で 127.0.0.1 の一度きりの待受へ届く（URL に推測不能なトークン）。
  // 時間切れ・Ourin 不通・「セッション表示」は通常の確認（ask）へ戻す。
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    // 他の mod の呼び出し・問い合わせ（origin がその mod）ではバルーンを出さない
    if (!permissionBalloon || verdict.decision !== 'ask' || next.origin.plugin !== 'engine') return verdict

    const token = crypto.randomUUID().replace(/-/g, '')
    const listener = $.process.spawn({ argv: ['python3', '-c', LISTENER_PY, token, String(PERMISSION_TIMEOUT_SEC)] })
    let decision: PermissionDecision | undefined
    permissionPending = true
    try {
      for await (const { stream, text } of listener) {
        if (stream !== 'stdout') continue
        const got = parseListener(text)
        if (got.port !== undefined) {
          const summary = permissionSummary(e.tool, e.input)
          const body = buildSend({ kind: 'permission', detail: summary }, permissionScript(summary, `http://127.0.0.1:${got.port}/${token}`), { receiver })
          let delivered = false
          if (transport !== 'ipc') {
            try {
              const res = await $.http.fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })
              delivered = parseStatus(res.text) !== undefined
            } catch {
              delivered = false
            }
          }
          if (!delivered && transport !== 'http') {
            const r = await $.process.run(['osascript', '-l', 'JavaScript', '-e', IPC_JXA], { stdin: body, timeoutMs: 5000 })
            delivered = r.exitCode === 0 && parseStatus(r.stdout) !== undefined
          }
          // Ourin に出せなければ待たずに通常の確認へ
          if (!delivered) break
        }
        if (got.decision) {
          decision = got.decision
          break
        }
      }
    } finally {
      permissionPending = false
    }

    switch (decision) {
      case 'allow':
        return { ...verdict, decision: 'allow', reason: 'ゴーストのバルーンで許可' }
      case 'deny':
        return { ...verdict, decision: 'deny', reason: 'ゴーストのバルーンで拒否されました' }
      case 'show':
        if (link) await $.process.run(['open', link], { timeoutMs: 5000 })
        return verdict
      default:
        return verdict
    }
  }).catch((_$, e, next) => next(e))
}
