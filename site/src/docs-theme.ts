// Starlight theming that matches the landing page: Mist palette, site fonts, ink-dark code.
import type { StarlightUserConfig } from '@astrojs/starlight/types'

const ink = '#15131f'

export const docsTheme = {
  customCss: ['./src/styles/docs-theme.css'],
  expressiveCode: {
    themes: ['github-dark-default'],
    useStarlightUiThemeColors: false,
    styleOverrides: {
      borderRadius: '12px',
      borderColor: '#2b2839',
      codeBackground: ink,
      codeFontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
      uiFontFamily: "'Bricolage Grotesque', 'Helvetica Neue', Arial, sans-serif",
      frames: {
        editorTabBarBackground: ink,
        editorActiveTabBackground: ink,
        editorActiveTabIndicatorBottomColor: '#7ee6ce',
        editorTabBarBorderBottomColor: '#2b2839',
        terminalBackground: ink,
        terminalTitlebarBackground: ink,
        terminalTitlebarBorderBottomColor: '#2b2839',
        frameBoxShadowCssValue: 'none',
      },
    },
  },
} satisfies Pick<StarlightUserConfig, 'customCss' | 'expressiveCode'>
