import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'

// Headless SwiftShader backs a WebGPU canvas swap chain only when the compositor shares Dawn's
// Vulkan device; without it Chromium drops the WebGPU instance and never presents WebGPU frames.
export const swiftShaderArgs: readonly string[] = [
  '--use-angle=vulkan',
  '--enable-features=Vulkan,VulkanFromANGLE',
  '--use-webgpu-adapter=swiftshader',
]

// ANGLE opens Vulkan through the system loader: a host without a Vulkan driver (CI) gets no device
// and the GPU process exits, and a host with one composites on its GPU. Pin both to SwiftShader.
export function swiftShaderEnv(): Record<string, string> {
  const driver = join(dirname(chromium.executablePath()), 'vk_swiftshader_icd.json')
  if (!existsSync(driver)) {
    throw new Error(
      `Chromium's SwiftShader Vulkan driver is missing; run \`bunx playwright install chromium\``,
    )
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return { ...env, VK_ICD_FILENAMES: driver, VK_DRIVER_FILES: driver }
}
