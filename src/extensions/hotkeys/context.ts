import type { KeyContextInit } from '@fregat/hotkeys'

export interface TerminalKeyContextState {
  readonly alternateScreen: boolean
  readonly mouseReporting: boolean
}

export function terminalKeyContext(state: TerminalKeyContextState): KeyContextInit {
  return {
    identifiers: ['Terminal'],
    values: {
      mode: state.alternateScreen ? 'alternate' : 'normal',
      mouse: state.mouseReporting ? 'on' : 'off',
    },
  }
}
