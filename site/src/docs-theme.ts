// Starlight theming that matches the landing page: the tab's scene colours, Paper Mono, framed code.
import githubLight from '@shikijs/themes/github-light-high-contrast'
import type { StarlightUserConfig } from '@astrojs/starlight/types'

const ground = 'var(--ground)'
const line = 'var(--line)'
const mono = "'Paper Mono', ui-monospace, Menlo, Consolas, monospace"

export const docsTheme = {
  customCss: ['./src/styles/docs-theme.css'],
  expressiveCode: {
    themes: ['github-dark-default'],
    useStarlightUiThemeColors: false,
    styleOverrides: {
      borderRadius: '0',
      borderColor: line,
      codeBackground: 'var(--surface)',
      codeFontFamily: mono,
      uiFontFamily: mono,
      frames: {
        editorTabBarBackground: ground,
        editorActiveTabBackground: 'var(--surface)',
        editorActiveTabIndicatorBottomColor: 'var(--accent)',
        editorTabBarBorderBottomColor: line,
        terminalBackground: 'var(--surface)',
        terminalTitlebarBackground: ground,
        terminalTitlebarBorderBottomColor: line,
        frameBoxShadowCssValue: 'none',
      },
    },
  },
} satisfies Pick<StarlightUserConfig, 'customCss' | 'expressiveCode'>

export const docsCodeThemes = {
  light: githubLight,
  dark: docsTheme.expressiveCode.themes[0],
} as const
