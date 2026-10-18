import { test, expect, mock } from 'claude-code/testing'
import { parseListener, permissionScript, permissionSummary } from './sstp'

// 許可フロー用リグ: beneath の判定・待受の出力・Ourin への到達性を差し替える
function rig(on: any, opts: { verdict: 'allow' | 'ask' | 'deny'; decision?: string; reachable?: boolean }) {
  mock.clock(on)
  const sent: string[] = []
  const spawned: string[][] = []
  const opened: string[][] = []
  on('tool.check', () => ({ decision: opts.verdict }))
  on('http.fetch', (_$: any, e: { init?: { body?: string } }) => {
    if (opts.reachable === false) throw new Error('ECONNREFUSED')
    sent.push(String(e.init?.body ?? ''))
    return { value: { status: 200, ok: true, headers: {}, text: 'SSTP/1.4 200 OK\r\n\r\n' } }
  })
  on('process.run', (_$: any, e: { argv: string[] }) => {
    opened.push([...e.argv])
    return { value: { exitCode: e.argv[0] === 'open' ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_$: any, e: { argv: string[] }) {
    spawned.push([...e.argv])
    yield { stream: 'stdout', text: 'PORT 5555\n' }
    if (opts.decision) yield { stream: 'stdout', text: `DECISION ${opts.decision}\n` }
    return { code: 0, signal: null }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('env.get', (_$: any, e: { name: string }) => ({ value: e.name === 'CLAUDE_CODE_HOST_SESSION_ID' ? 'local_abc-123' : '/home/test' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('session.start', (_$: any, e: { cwd: string }) => ({ cwd: e.cwd }))
  return { sent, spawned, opened }
}

const start = ($: any) => $.session.start({ cwd: '/work', surface: null, isInteractive: true })
const check = ($: any) => $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })

test('補助関数: 待受出力の解析・要約・ボタン', () => {
  expect(parseListener('PORT 4321\nDECISION deny\n')).toEqual({ port: 4321, decision: 'deny' })
  expect(parseListener('noise')).toEqual({})
  expect(permissionSummary('Bash', { command: 'git  push\n origin' })).toBe('Bash: git push origin')
  expect(permissionSummary('Edit', { file_path: '/a/b/c.ts' })).toBe('Edit: c.ts')
  const s = permissionScript('Bash: ls', 'http://127.0.0.1:1/t')
  expect(s).toContain('\\*\\q[許可,script:\\0\\![execute,http-get,http://127.0.0.1:1/t/allow,--nofile]\\s[5]了解、許可したよ。]')
  expect(s).toContain('\\q[セッション表示,script:\\0\\![execute,http-get,http://127.0.0.1:1/t/show,--nofile]')
  expect(s).toContain('\\q[拒否,script:\\0\\![execute,http-get,http://127.0.0.1:1/t/deny,--nofile]')
})

for (const [decision, expected] of [['allow', 'allow'], ['deny', 'deny'], ['show', 'ask'], ['timeout', 'ask']] as const) {
  test(`バルーンで ${decision} → ${expected}`, async ($: any, on: any) => {
    const r = rig(on, { verdict: 'ask', decision })
    await start($)
    const v = await check($)
    expect(v.decision).toBe(expected)
    expect(r.spawned.length).toBe(1)
    // 待受はトークンと時間切れ秒数を受け取る
    expect(r.spawned[0]?.[3]).toMatch(/^[0-9a-f]{32}$/)
    const balloon = r.sent.find(b => b.includes('Reference0: permission'))
    expect(balloon).toBeDefined()
    expect(balloon).toContain('Reference1: Bash: rm -rf build')
    expect(balloon).toContain(`http-get,http://127.0.0.1:5555/${r.spawned[0]?.[3]}/allow,--nofile`)
    if (decision === 'deny') expect(String(v.reason)).toContain('ゴーストのバルーンで拒否')
    if (decision === 'show') expect(r.opened.some(a => a[0] === 'open' && a[1] === 'claude://code/continue?session=local_abc-123')).toBe(true)
  })
}

test('Ourin に出せなければ待たずに通常の確認へ', async ($: any, on: any) => {
  const r = rig(on, { verdict: 'ask', decision: 'allow', reachable: false })
  await start($)
  const v = await check($)
  // バルーンを出せないので、待受が allow を返しても許可扱いにしない
  expect(v.decision).toBe('ask')
  expect(r.sent.length).toBe(0)
})

test('ask でなければバルーンを出さない', async ($: any, on: any) => {
  const r = rig(on, { verdict: 'allow' })
  await start($)
  const v = await check($)
  expect(v.decision).toBe('allow')
  expect(r.spawned.length).toBe(0)
})
