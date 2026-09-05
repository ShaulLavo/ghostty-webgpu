import {
  hostSupportsCompatibility,
  loadVerifiedResolverBundle,
  selectResolverTarget,
  type NativeResolverTarget,
  type VerifiedResolverBundle,
} from './manifest.js'
import { runResolverProcess, type ResolverProcessOutcome } from './process.js'
import { projectNativeAppearance } from './projection.js'
import { parseCanonicalNativePayload } from './schema.js'
import type {
  GhosttyConfigAppearance,
  GhosttyConfigResolveResult,
  NativeResolverPayload,
} from './types.js'

export interface ResolverDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly hostCompatible: (bundle: VerifiedResolverBundle) => boolean
  readonly loadBundle: (target: NativeResolverTarget) => Promise<VerifiedResolverBundle>
  readonly parse: (bytes: Uint8Array) => NativeResolverPayload
  readonly platform: string
  readonly architecture: string
  readonly project: (payload: NativeResolverPayload) => GhosttyConfigAppearance
  readonly run: (
    bundle: VerifiedResolverBundle,
    environment: Readonly<Record<string, string | undefined>>,
  ) => Promise<ResolverProcessOutcome>
}

const PRODUCTION_DEPENDENCIES: ResolverDependencies = {
  architecture: process.arch,
  environment: process.env,
  hostCompatible: (bundle) => hostSupportsCompatibility(bundle.compatibility),
  loadBundle: loadVerifiedResolverBundle,
  parse: parseCanonicalNativePayload,
  platform: process.platform,
  project: projectNativeAppearance,
  run: (bundle, environment) =>
    runResolverProcess({
      cwd: bundle.cwd,
      environment,
      executable: bundle.executable,
      resources: bundle.resources,
    }),
}

export async function resolveGhosttyConfigAppearanceWithDependencies(
  dependencies: ResolverDependencies,
): Promise<GhosttyConfigResolveResult> {
  const target = selectResolverTarget(dependencies.platform, dependencies.architecture)
  if (!target) return unavailable('unsupported-platform')
  const bundle = await safeLoadBundle(target, dependencies)
  if (!bundle) return unavailable('resolver-failed')
  if (!safeHostCompatible(bundle, dependencies)) return unavailable('unsupported-platform')
  const outcome = await safeRun(bundle, dependencies)
  if (!outcome) return unavailable('resolver-failed')
  if (outcome.kind === 'unavailable') return { status: 'unavailable', reason: outcome.reason }
  return projectOutput(outcome.bytes, dependencies)
}

export function resolveGhosttyConfigAppearance(): Promise<GhosttyConfigResolveResult> {
  return resolveGhosttyConfigAppearanceWithDependencies(PRODUCTION_DEPENDENCIES)
}

async function safeLoadBundle(
  target: NativeResolverTarget,
  dependencies: ResolverDependencies,
): Promise<VerifiedResolverBundle | null> {
  try {
    return await dependencies.loadBundle(target)
  } catch {
    return null
  }
}

function safeHostCompatible(
  bundle: VerifiedResolverBundle,
  dependencies: ResolverDependencies,
): boolean {
  try {
    return dependencies.hostCompatible(bundle)
  } catch {
    return false
  }
}

async function safeRun(
  bundle: VerifiedResolverBundle,
  dependencies: ResolverDependencies,
): Promise<ResolverProcessOutcome | null> {
  try {
    return await dependencies.run(bundle, dependencies.environment)
  } catch {
    return null
  }
}

function projectOutput(
  bytes: Uint8Array,
  dependencies: ResolverDependencies,
): GhosttyConfigResolveResult {
  try {
    const payload = dependencies.parse(bytes)
    const appearance = dependencies.project(payload)
    return { appearance, status: 'ready' }
  } catch {
    return unavailable('invalid-output')
  }
}

function unavailable(
  reason: Extract<GhosttyConfigResolveResult, { readonly status: 'unavailable' }>['reason'],
): GhosttyConfigResolveResult {
  return { reason, status: 'unavailable' }
}
