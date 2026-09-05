import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const hardware = process.env.GHOSTTY_BROWSER_HARDWARE === '1'
const launchArgs = ['--enable-unsafe-webgpu']
if (process.platform === 'linux' && !hardware) {
  launchArgs.push('--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader')
}
if (hardware && process.platform === 'linux' && process.env.WAYLAND_DISPLAY)
  launchArgs.push('--ozone-platform=wayland')

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      headless: !hardware,
      instances: [{ browser: 'chromium' }],
      provider: playwright({ launchOptions: { args: launchArgs, channel: 'chromium' } }),
      screenshotFailures: false,
    },
    // SwiftShader can lose adapters when browser files churn WebGPU devices concurrently.
    fileParallelism: false,
    include: ['src/**/*.browser.test.ts'],
    name: 'browser',
  },
})
