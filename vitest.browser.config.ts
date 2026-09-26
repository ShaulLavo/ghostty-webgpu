import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { swiftShaderArgs, swiftShaderEnv } from './scripts/swiftshader-launch'

const hardware = process.env.GHOSTTY_BROWSER_HARDWARE === '1'
const engine = process.env.GHOSTTY_BROWSER_ENGINE ?? 'chromium'
if (engine !== 'chromium' && engine !== 'firefox' && engine !== 'webkit')
  throw new Error(`Unsupported GHOSTTY_BROWSER_ENGINE: ${engine}`)

const launchArgs = engine === 'chromium' ? ['--enable-unsafe-webgpu'] : []
const swiftShader = engine === 'chromium' && process.platform === 'linux' && !hardware
if (swiftShader) launchArgs.push(...swiftShaderArgs)
// Full headless Chromium finds no adapter with ANGLE on Vulkan; the headless shell does.
const chromiumChannel = swiftShader ? undefined : 'chromium'
if (
  engine === 'chromium' &&
  hardware &&
  process.platform === 'linux' &&
  process.env.WAYLAND_DISPLAY
)
  launchArgs.push('--ozone-platform=wayland')

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      headless: !hardware,
      // The preview UI scales the iframe and changes screenshot dimensions.
      ui: false,
      instances: [{ browser: engine }],
      provider: playwright({
        launchOptions:
          engine === 'chromium'
            ? {
                args: launchArgs,
                channel: chromiumChannel,
                env: swiftShader ? swiftShaderEnv() : undefined,
              }
            : {},
      }),
      screenshotFailures: false,
    },
    // SwiftShader can lose adapters when browser files churn WebGPU devices concurrently.
    fileParallelism: false,
    include: ['src/**/*.browser.test.ts'],
    name: 'browser',
  },
})
