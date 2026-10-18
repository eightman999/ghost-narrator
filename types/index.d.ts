export type Stage = { kind: string; line: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'ghost-narrator': { stage: Stage }
  }
}
