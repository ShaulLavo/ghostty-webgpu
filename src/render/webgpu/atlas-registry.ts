import type { TerminalFittedFont } from '../../term/types.js'
import { copyFittedFont } from '../shared/config.js'
import { SharedGlyphAtlas, type SharedAtlasOwner } from './shared-atlas.js'

interface AtlasScope {
  readonly entries: Map<string, SharedGlyphAtlas>
  readonly retire: () => void
  readonly resources: FontFaceSet
  resourceIdentity: string
  owners: number
}

const scopes = new WeakMap<FontFaceSet, AtlasScope>()
const registrations = new WeakMap<SharedGlyphAtlas, AtlasScope>()
const faceIdentities = new WeakMap<FontFace, number>()
const fontEvents = ['loading', 'loadingdone', 'loadingerror'] as const
let nextFaceIdentity = 0

function fontResources(canvas: HTMLCanvasElement | OffscreenCanvas): FontFaceSet | undefined {
  if ('ownerDocument' in canvas) return canvas.ownerDocument.fonts
  const fonts: unknown = Reflect.get(globalThis, 'fonts')
  if (typeof FontFaceSet !== 'undefined' && fonts instanceof FontFaceSet) return fonts
  if (typeof document !== 'undefined') return document.fonts
}

function resourceIdentity(resources: FontFaceSet): string {
  return JSON.stringify(
    Array.from(resources, (face) => {
      let identity = faceIdentities.get(face)
      if (identity === undefined) {
        identity = ++nextFaceIdentity
        faceIdentities.set(face, identity)
      }
      return [
        identity,
        face.status,
        face.family,
        face.style,
        face.weight,
        face.stretch,
        face.unicodeRange,
        face.featureSettings,
        face.variationSettings,
        face.ascentOverride,
        face.descentOverride,
        face.lineGapOverride,
        Reflect.get(face, 'sizeAdjust'),
        face.display,
      ]
    }),
  )
}

function scopeFor(resources: FontFaceSet): AtlasScope {
  const existing = scopes.get(resources)
  const identity = resourceIdentity(resources)
  if (existing) {
    if (existing.resourceIdentity !== identity) {
      existing.retire()
      existing.resourceIdentity = identity
    }
    return existing
  }
  const entries = new Map<string, SharedGlyphAtlas>()
  const scope = {
    entries,
    resources,
    owners: 0,
    resourceIdentity: identity,
    retire: () => entries.clear(),
  }
  for (const event of fontEvents) resources.addEventListener(event, scope.retire)
  scopes.set(resources, scope)
  return scope
}

export function sharedAtlasKey(font: TerminalFittedFont): string {
  return JSON.stringify(copyFittedFont(font))
}

export function acquireSharedAtlas(
  font: TerminalFittedFont,
  owner: SharedAtlasOwner,
  canvas: HTMLCanvasElement | OffscreenCanvas,
): SharedGlyphAtlas {
  const key = sharedAtlasKey(font)
  const resources = fontResources(canvas)
  if (!resources) {
    const shared = new SharedGlyphAtlas(key, font)
    shared.attach(owner)
    return shared
  }
  const scope = scopeFor(resources)
  let shared = scope.entries.get(key)
  if (!shared) {
    shared = new SharedGlyphAtlas(key, font)
    scope.entries.set(key, shared)
    registrations.set(shared, scope)
  }
  scope.owners += 1
  shared.attach(owner)
  return shared
}

export function releaseSharedAtlas(shared: SharedGlyphAtlas, owner: SharedAtlasOwner): void {
  if (!shared.detach(owner)) return
  const scope = registrations.get(shared)
  if (!scope) return
  scope.owners -= 1
  if (shared.ownerCount === 0 && scope.entries.get(shared.key) === shared)
    scope.entries.delete(shared.key)
  if (scope.owners !== 0) return
  for (const event of fontEvents) scope.resources.removeEventListener(event, scope.retire)
  scopes.delete(scope.resources)
}
