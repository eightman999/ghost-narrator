import { test, expect, mock } from 'claude-code/testing'
import { buildSend, escapeScript, isCheckCommand, parseStatus, templateLine } from './sstp'

// SSTP 送信を記録するリグ。reachable=false で接続失敗を再現
// http=false で HTTP 不通、ipc=false で IPC も不通を再現
function rig($: any, on: any, reachable = true, ipc = false) {
  const clock = mock.clock(on)
  const sent: string[] = []
  const toasts: string[] = []
  on('http.fetch', (_$: any, e: { url: string; init?: { body?: string } }) => {
    if (!reachable) throw new Error('ECONNREFUSED')
    sent.push(String(e.init?.body ?? ''))
    return { value: { status: 200, ok: true, headers: {}, text: 'SSTP/1.4 200 OK\r\n\r\n' } }
  })
  const ipcSent: string[] = []
  on('process.run', (_$: any, e: { argv: string[]; init?: { stdin?: string } }) => {
    if (!ipc) return { value: { exitCode: 1, stdout: '', stderr: 'no response from Ourin', isStdoutTruncated: false, isStderrTruncated: false } }
    ipcSent.push(String(e.init?.stdin ?? ''))
    return { value: { exitCode: 0, stdout: 'SSTP/1.4 204 No Content\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$: any, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('env.get', (_$: any, e: { name: string }) => ({
    value: e.name === 'CLAUDE_CODE_HOST_SESSION_ID' ? 'local_abc-123' : '/home/test',
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', (_$: any, e: { path: string }) =>
    /surface0000|element0005/.test(e.path) ? { value: { base64: PNG1 } } : { deny: 'missing' },
  )
  on('session.start', (_$: any, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'Bash' }, (_$: any, e: { command: string }) =>
    e.command.includes('pytest') ? { result: {}, text: '1 failed', isError: true } : { result: {}, text: 'ok' },
  )
  on('tool.call', { tool: 'Edit' }, () => ({ result: {}, text: 'ok' }))
  return { clock, sent, toasts, ipcSent }
}

// 1x1 の透明 PNG
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const start = ($: any) => $.session.start({ cwd: '/work', surface: null, isInteractive: true })

test('SEND SSTP/1.4 の形式と Script フォールバック', async () => {
  const req = buildSend({ kind: 'pass', detail: 'npm test' }, templateLine({ kind: 'pass', detail: 'npm test' }))
  expect(req.startsWith('SEND SSTP/1.4\r\n')).toBe(true)
  expect(req).toContain('Sender: Claude Code\r\n')
  expect(req).toContain('Event: OnClaudeCode\r\n')
  expect(req).toContain('Reference0: pass\r\n')
  expect(req).toMatch(/Script: \\0.*npm test.*\\e\r\n/)
  expect(req.endsWith('\r\n\r\n')).toBe(true)
  // 改行・さくらスクリプト制御文字の無害化
  expect(buildSend({ kind: 'say', detail: 'a\r\nb' }, 'x').includes('a\r\nb')).toBe(false)
  expect(escapeScript('100% \\e')).toBe('100\\% \\\\e')
  expect(parseStatus('SSTP/1.4 204 No Content')).toBe(204)
  expect(isCheckCommand('cd x && npm run test')).toBe(true)
  expect(isCheckCommand('ls -la')).toBe(false)
})

test('起動・テスト失敗・編集を順に実況し、頻出イベントは間引く', async ($, on) => {
  const r = rig($, on)
  await start($)
  await r.clock.advance(500)
  expect(r.sent.length).toBe(1)
  expect(r.sent[0]).toContain('Reference0: start')

  await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  await r.clock.advance(500)
  expect(r.sent[1]).toContain('Reference0: fail')

  // 直後の編集2回は間引かれ、最後の1件だけが静穏時間後に出る
  await $.tool.call({ tool: 'Edit', file_path: '/w/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/b.ts', old_string: 'a', new_string: 'b' })
  await r.clock.advance(1000)
  expect(r.sent.length).toBe(2)
  await r.clock.advance(6000)
  expect(r.sent.length).toBe(3)
  expect(r.sent[2]).toContain('Reference1: b.ts')
})

test('Ourin 未起動ならトースト1回で黙り、ツールは止めない', async ($, on) => {
  const r = rig($, on, false)
  await start($)
  const out: any = await $.tool.call({ tool: 'Bash', command: 'pytest' })
  expect(out.isError).toBe(true)
  await r.clock.advance(3000)
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  await r.clock.advance(3000)
  expect(r.toasts.filter(t => t.includes('届かない')).length).toBe(1)
})

test('/ghost mute で実況停止、say は送る', async ($, on) => {
  const r = rig($, on)
  await start($)
  await r.clock.advance(500)
  await $.command.run({ command: 'ghost', args: 'mute' } as any)
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  await $.command.run({ command: 'ghost', args: 'say こんにちは' } as any)
  await r.clock.advance(1000)
  expect(r.sent.length).toBe(2)
  expect(r.sent[1]).toContain('Reference0: say')
  expect(r.sent[1]).toContain('こんにちは')
})

test('HTTP 不通なら Distributed IPC（osascript）へフォールバック', async ($, on) => {
  const r = rig($, on, false, true)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  // IPC 経路は非同期段が多く、送信完了まで複数回の進行が要る
  await r.clock.advance(2000)
  await r.clock.advance(5000)
  expect(r.sent.length).toBe(0)
  expect(r.ipcSent.length).toBe(2)
  expect(r.ipcSent[1]).toContain('Reference0: pass')
  expect(r.toasts.some(t => t.includes('届かない'))).toBe(false)
})

test('Claude 内ペインに表情付きシェルとバルーンを描く（Ourin 不要）', async ($, on) => {
  const r = rig($, on, false, false)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await r.clock.advance(2000)
  await r.clock.advance(5000)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui: any = await ($.ui as any).mount({
      plugin: 'ghost-narrator',
      surface,
      component: 'Pane',
      requestId: 'ghost',
      props: { title: 'Ghost', isFocused: false, bodyColumns: 40, placement: 'dock' },
    })
    expect((await ui.find({ text: /通った/ }))).toBeDefined()
    const svg = await ui.find({ type: 'Svg' })
    if (surface === 'desktop') {
      expect(svg).toBeDefined()
      // 笑顔パーツ（element0005）が 85,80 に重なっている
      expect(String(svg.props.source)).toContain('x="85" y="80"')
    } else {
      expect(svg).toBeUndefined()
    }
    await ui.unmount()
  }
})

test('完了・失敗の実況だけバルーンに Claude セッションへ戻る選択肢を付ける', async ($, on) => {
  const r = rig($, on)
  await start($)
  await r.clock.advance(500)
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  await r.clock.advance(500)
  const choice = '\\q[セッションを開く,script:\\![open,browser,claude://code/continue?session=local_abc-123]]'
  expect(r.sent[0]).not.toContain('\\q[')
  expect(r.sent[1]).toContain('Reference0: fail')
  expect(r.sent[1]).toContain(choice)
  // Script は切り詰めずに \e で閉じる
  expect(r.sent[1]).toMatch(/Script: .*open,browser,claude:\/\/code\/continue\?session=local_abc-123\]\]\\e\r\n/)
})

test('sessionLink=false ならリンクを付けない', { options: { sessionLink: false } } as any, async ($: any, on: any) => {
  const r = rig($, on)
  await start($)
  await r.clock.advance(500)
  await $.tool.call({ tool: 'Bash', command: 'pytest' })
  await r.clock.advance(500)
  expect(r.sent[1]).toContain('Reference0: fail')
  expect(r.sent[1]).not.toContain('\\q[')
})
