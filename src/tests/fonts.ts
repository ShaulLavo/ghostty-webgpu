/// <reference types="vite/client" />
import fontUrl from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url'

export const testFontUrl = new URL(fontUrl, import.meta.url).href
