// SSTP 組み立てと実況イベントの分類（純関数のみ。テスト対象）

export type Kind =
  | 'start' // セッション開始
  | 'prompt' // ユーザーの依頼
  | 'edit' // ファイル編集
  | 'run' // コマンド実行
  | 'pass' // 検証 PASS
  | 'fail' // 検証 FAIL / コマンド失敗
  | 'denied' // ガードが止めた
  | 'done' // ターン完了
  | 'aborted' // 中断
  | 'say' // /ghost say
  | 'permission' // 許可待ち（バルーンに選択肢）

export type Beat = { kind: Kind; detail: string }

// 頻出イベントは間引く。重要イベントは常に喋る
export const URGENT: ReadonlySet<Kind> = new Set(['fail', 'denied', 'done', 'aborted', 'say', 'start'])

const CHECK =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|typecheck|check)|pytest|cargo\s+(?:test|build|clippy)|go\s+(?:test|build|vet)|tsc|eslint|ruff|mypy|swift\s+(?:build|test)|xcodebuild|gradlew?\s+\S*(?:test|build)|make\s+(?:test|check))\b/

export const isCheckCommand = (cmd: string): boolean => CHECK.test(cmd)

// さくらスクリプトとして安全な文字列へ
export const escapeScript = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/[\r\n]+/g, ' ')

// SSTP ヘッダ値（改行禁止）
const headerValue = (s: string): string => s.replace(/[\r\n]+/g, ' ').slice(0, 200)
// Script は切り詰めない（選択肢やリンクを含むため）。改行だけ除く
const scriptValue = (s: string): string => s.replace(/[\r\n]+/g, ' ')

const basename = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

const short = (s: string, n = 32): string => (s.length > n ? `${s.slice(0, n)}…` : s)

const pick = <T>(xs: readonly T[], seed: number): T => xs[Math.abs(seed) % xs.length] as T

// 定型文（\0 = 本体側, \1 = 相方側）。ゴースト非依存にするため \s は 0/1 の基本番号のみ
export const templateLine = (b: Beat, seed = Date.now()): string => {
  const d = escapeScript(short(b.detail))
  switch (b.kind) {
    case 'start':
      return '\\0\\s[5]Claude Code 起動したよ。\\w8今日もよろしくね。'
    case 'prompt':
      return pick(['\\0\\s[0]お、新しいお仕事だね。', '\\0\\s[0]ふむふむ、了解。', '\\0\\s[5]任せて。'], seed)
    case 'edit':
      return pick([`\\0\\s[0]${d} を書き換え中…`, `\\0\\s[0]${d} いじってるよ。`], seed)
    case 'run':
      return `\\0\\s[0]${d} を実行中。`
    case 'pass':
      return `\\0\\s[5]${d}、通った！\\w8\\1\\s[10]やるじゃん。`
    case 'fail':
      return `\\0\\s[4]${d}、落ちてる…\\w8\\1\\s[10]見直しだな。`
    case 'denied':
      return `\\0\\s[3]危ない操作を止めといたよ。\\n\\_q${d}\\_q`
    case 'done':
      return pick(['\\0\\s[5]終わったよ、確認してね。', '\\0\\s[5]ひと区切りついたよ。'], seed)
    case 'aborted':
      return '\\0\\s[3]止められちゃった。'
    case 'say':
      return `\\0\\s[0]${d}`
    case 'permission':
      return `\\0\\s[3]許可がほしいよ。\\n\\_q${d}\\_q`
  }
}

export type SstpOptions = { receiver?: string; event?: string }

// SEND SSTP/1.4: ゴーストが OnClaudeCode を処理すればその台詞、しなければ Script を再生（SSP 互換挙動）
export const buildSend = (b: Beat, script: string, o: SstpOptions = {}): string => {
  const lines = [
    'SEND SSTP/1.4',
    'Sender: Claude Code',
    'Charset: UTF-8',
    `Event: ${o.event ?? 'OnClaudeCode'}`,
    `Reference0: ${headerValue(b.kind)}`,
    `Reference1: ${headerValue(b.detail)}`,
    `Script: ${scriptValue(script.replace(/\\e$/, ''))}\\e`,
  ]
  if (o.receiver) lines.push(`ReceiverGhostName: ${headerValue(o.receiver)}`)
  return `${lines.join('\r\n')}\r\n\r\n`
}

// 応答の1行目からステータスを取る（例: "SSTP/1.4 200 OK"）
export const parseStatus = (text: string): number | undefined => {
  const m = /^SSTP\/\d\.\d\s+(\d{3})/.exec(text.trimStart())
  return m ? Number(m[1]) : undefined
}

export const aiPrompt = (b: Beat): string =>
  `あなたはデスクトップマスコット（伺かのゴースト）です。相棒の AI エンジニアの作業を横で見て、一言だけ実況します。
口調: 親しみやすく短く、日本語40字以内、絵文字なし、ネタバレや長文説明なし。台詞の本文だけを出力。
出来事: ${b.kind}
詳細: ${short(b.detail, 120)}`

// AI 台詞をスクリプト化（表情は kind から決める）
export const aiScript = (b: Beat, text: string): string => {
  const face = b.kind === 'fail' || b.kind === 'aborted' ? 4 : b.kind === 'denied' ? 3 : b.kind === 'pass' || b.kind === 'done' ? 5 : 0
  return `\\0\\s[${face}]${escapeScript(short(text.trim(), 60))}`
}

export { basename, short }

// Ourin の Distributed IPC（jp.ourin.sstp.request/response）へ stdin の SSTP を送り、応答を stdout に出す JXA。
// HTTP 受信口が閉じていても Ourin 既定で有効な経路。
export const IPC_JXA = `ObjC.import('Foundation')
function run() {
  const req = $.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, 4).js
  const center = $.NSDistributedNotificationCenter.defaultCenter
  const id = 'cc-' + Date.now() + '-' + Math.random().toString(36).slice(2)
  let got = null
  ObjC.registerSubclass({ name: 'GhostNarratorObs', methods: { 'onResp:': { types: ['void', ['id']], implementation: function (n) {
    if (ObjC.unwrap(n.userInfo.objectForKey('id')) === id) got = ObjC.unwrap(n.userInfo.objectForKey('response'))
  } } } })
  center.addObserverSelectorNameObject($.GhostNarratorObs.alloc.init, 'onResp:', 'jp.ourin.sstp.response', $())
  center.postNotificationNameObjectUserInfoDeliverImmediately('jp.ourin.sstp.request', $(), $.NSDictionary.dictionaryWithObjectsForKeys($([id, req]), $(['id', 'request'])), true)
  const until = Date.now() + 3000
  while (got === null && Date.now() < until) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05))
  if (got === null) throw new Error('no response from Ourin')
  return got
}`

// argv[0] のアプリの最大の通常ウィンドウ枠（CG 座標: 左上原点）と主画面の寸法を JSON で返す JXA。
// 画面収録の許可は不要（枠と所有者名だけを読む）。表示中が無ければ非表示のものも候補にする。
export const APP_FRAME_JXA = `ObjC.import('CoreGraphics')
ObjC.import('AppKit')
function run(argv) {
  const owner = argv[0]
  const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0))) || []
  const wins = all.filter(w => w.kCGWindowOwnerName === owner && w.kCGWindowLayer === 0 && w.kCGWindowBounds.Width >= 200 && w.kCGWindowBounds.Height >= 200)
  const area = w => w.kCGWindowBounds.Width * w.kCGWindowBounds.Height
  const pick = list => list.reduce((a, w) => (!a || area(w) > area(a) ? w : a), null)
  const best = pick(wins.filter(w => w.kCGWindowIsOnscreen)) || pick(wins)
  const main = $.NSScreen.screens.objectAtIndex(0)
  const f = main.frame, v = main.visibleFrame
  return JSON.stringify({ win: best ? best.kCGWindowBounds : null, screenH: f.size.height, visible: { x: v.origin.x, y: v.origin.y, w: v.size.width, h: v.size.height } })
}`

export type CgRect = { X: number; Y: number; Width: number; Height: number }
export type AppFrame = { win: CgRect | null; screenH: number; visible: { x: number; y: number; w: number; h: number } }

// Ourin の \![move] は生の X/Y を Cocoa 座標（左下原点）で扱うため、CG 座標の窓枠から Cocoa の原点を求める。
// 窓の右外に余白があれば外側へ、無ければ窓の内側右下へ置く。下端は窓の下端（Dock の上）に揃える。
export const dockOrigin = (f: AppFrame, ghost = { w: 300, h: 400 }, gap = 4): { x: number; y: number } | undefined => {
  if (!f.win) return undefined
  const v = f.visible
  const right = f.win.X + f.win.Width
  const outside = right + gap + ghost.w <= v.x + v.w
  const x = outside ? right + gap : Math.min(right, v.x + v.w) - ghost.w - gap
  const bottom = f.screenH - (f.win.Y + f.win.Height)
  const y = Math.max(v.y, Math.min(bottom, v.y + v.h - ghost.h))
  return { x: Math.round(Math.max(v.x, x)), y: Math.round(y) }
}

// イベントを伴わない素のスクリプト送信（移動など）
export const buildScriptSend = (script: string, o: SstpOptions = {}): string => {
  const lines = ['SEND SSTP/1.4', 'Sender: Claude Code', 'Charset: UTF-8', `Script: ${scriptValue(script.replace(/\\e$/, ''))}\\e`]
  if (o.receiver) lines.push(`ReceiverGhostName: ${headerValue(o.receiver)}`)
  return `${lines.join('\r\n')}\r\n\r\n`
}

// さくらスクリプトからバルーンに出す本文だけを取り出す（\0 \s[5] \w8 \![...] \_q 等を除去、\n は改行）
export const plainText = (script: string): string =>
  script
    .replace(/\\n(\[[^\]]*\])?/g, '\n')
    .replace(/\\[!&]\[[^\]]*\]/g, '')
    .replace(/\\_?[a-zA-Z*][0-9]*(\[[^\]]*\])?/g, '')
    .replace(/\\\\/g, '\\')
    .replace(/\\%/g, '%')
    .trim()

// 出来事ごとの表情（emily4: element0005 笑顔 / 0003 驚き / 0021 困り。0 は素の顔）
export const faceFor = (kind: string): string | undefined =>
  kind === 'pass' || kind === 'done' || kind === 'start'
    ? 'element0005.png'
    : kind === 'fail' || kind === 'denied'
      ? 'element0003.png'
      : kind === 'aborted'
        ? 'element0021.png'
        : undefined

// シェル（surface0000 + 顔パーツ 85,80）を data URI の SVG にする。Svg の上限 131072 文字に収める
export const shellSvg = (base: { b64: string; w: number; h: number }, face?: { b64: string; x: number; y: number; w: number; h: number }): string => {
  const img = (b64: string, x: number, y: number, w: number, h: number) =>
    `<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${b64}"/>`
  // 旧来シェルの透過色（純緑 #00FF00）を抜く: alpha = 1 + 3R + 3B - 3G（純緑で 0、肌や服は 1 に飽和）
  const key = '<filter id="k"><feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  3 -3 3 0 1"/></filter>'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${base.w} ${base.h}">${key}<g filter="url(#k)">${img(base.b64, 0, 0, base.w, base.h)}${face ? img(face.b64, face.x, face.y, face.w, face.h) : ''}</g></svg>`
}

// PNG の IHDR から幅・高さを読む（base64 先頭 32 文字＝24 バイトで足りる）
export const pngSize = (b64: string): { w: number; h: number } | undefined => {
  const bin = atob(b64.slice(0, 32))
  if (bin.length < 24 || bin.slice(1, 4) !== 'PNG') return undefined
  const u32 = (o: number) => ((bin.charCodeAt(o) << 24) | (bin.charCodeAt(o + 1) << 16) | (bin.charCodeAt(o + 2) << 8) | bin.charCodeAt(o + 3)) >>> 0
  return { w: u32(16), h: u32(20) }
}

// Claude デスクトップのセッションへ戻るリンク（claude://code/continue は local_ で始まる ID だけを受け付ける）
export const sessionLink = (hostSessionId: string | undefined): string | undefined =>
  hostSessionId && /^local_[A-Za-z0-9-]{1,64}$/.test(hostSessionId)
    ? `claude://code/continue?session=${hostSessionId}`
    : undefined

// 注意を向けてほしい出来事だけ、バルーンにセッションへ飛ぶ選択肢を付ける
export const LINKED: ReadonlySet<Kind> = new Set(['done', 'fail', 'denied', 'aborted'])

// \q[タイトル,script:\![open,browser,URL]]（SSP 互換。ネストした [] はそのまま書ける）
export const withSessionChoice = (script: string, link: string): string =>
  `${script.replace(/\\e$/, '')}\\n\\n\\q[セッションを開く,script:\\![open,browser,${link}]]`

// 許可バルーンのボタンから結果を受け取る一度きりの待受（127.0.0.1、空きポート）。
// argv: token, timeoutSec。標準出力に "PORT <n>" を出し、/<token>/<allow|deny|show> の要求だけを受けて
// "DECISION <x>" を出して終わる。時間切れは "DECISION timeout"。トークン不一致の要求は無視する。
export const LISTENER_PY = `import socket, sys
tok, limit = sys.argv[1], float(sys.argv[2])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(('127.0.0.1', 0)); s.listen(4); s.settimeout(limit)
print('PORT', s.getsockname()[1], flush=True)
while True:
    try:
        c, _ = s.accept()
    except socket.timeout:
        print('DECISION timeout', flush=True); break
    c.settimeout(5)
    try:
        line = c.recv(4096).split(b'\\r\\n', 1)[0].decode('latin1')
    except Exception:
        line = ''
    try:
        c.sendall(b'HTTP/1.1 204 No Content\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n')
    finally:
        c.close()
    parts = line.split(' ')
    if len(parts) >= 2:
        p = parts[1].strip('/').split('/')
        if len(p) == 2 and p[0] == tok and p[1] in ('allow', 'deny', 'show'):
            print('DECISION', p[1], flush=True); break
`

export type PermissionDecision = 'allow' | 'deny' | 'show' | 'timeout'

// 待受の出力から PORT / DECISION を取り出す（行単位、複数行が一度に届いてもよい）
export const parseListener = (text: string): { port?: number; decision?: PermissionDecision } => {
  const out: { port?: number; decision?: PermissionDecision } = {}
  for (const line of text.split(/\r?\n/)) {
    const port = /^PORT (\d+)$/.exec(line.trim())
    if (port) out.port = Number(port[1])
    const d = /^DECISION (allow|deny|show|timeout)$/.exec(line.trim())
    if (d) out.decision = d[1] as PermissionDecision
  }
  return out
}

// 何の許可かを一行に（Bash はコマンド、ファイル系はファイル名、ほかはツール名）
export const permissionSummary = (tool: string, input: unknown): string => {
  const i = (input ?? {}) as Record<string, unknown>
  if (typeof i.command === 'string') return `${tool}: ${short(i.command.replace(/\s+/g, ' '), 60)}`
  if (typeof i.file_path === 'string') return `${tool}: ${basename(i.file_path)}`
  if (typeof i.url === 'string') return `${tool}: ${short(i.url, 60)}`
  return tool
}

// 許可・セッション表示・拒否の選択肢付きバルーン。\* で選択肢の時間切れを止める
export const permissionScript = (summary: string, base: string): string => {
  // 押した後にゴーストが一言返す（本文付きのスクリプトにする。押したことが分かる）
  const reply: Record<string, string> = { allow: '\\s[5]了解、許可したよ。', show: '\\s[0]セッションを開くね。', deny: '\\s[4]やめておくね。' }
  const button = (label: string, action: string) =>
    `\\q[${label},script:\\0\\![execute,http-get,${base}/${action},--nofile]${reply[action] ?? ''}]`
  return `\\0\\s[3]許可がほしいよ。\\n\\n${escapeScript(summary)}\\n\\n\\*${button('許可', 'allow')}  ${button('セッション表示', 'show')}  ${button('拒否', 'deny')}\\e`
}
