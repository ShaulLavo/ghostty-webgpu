import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const launchArgs = ['--enable-unsafe-webgpu']
if (process.platform === 'linux') {
  launchArgs.push('--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader')
}

export default defineConfig({
  test: {
    browser: {
      enabled: true,
      headless: true,
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
