import type { ShaderUniformField, ShaderVector3, ShaderVector4 } from './types.js'

type UniformType = ShaderUniformField['type']

interface UniformDefinition {
  readonly name: string
  readonly type: UniformType
  readonly count: number
}

function defineUniforms<const T extends readonly UniformDefinition[]>(fields: T): T {
  return fields
}

const UNIFORM_DEFINITIONS = defineUniforms([
  { name: 'iResolution', type: 'vec3', count: 1 },
  { name: 'iTime', type: 'float', count: 1 },
  { name: 'iTimeDelta', type: 'float', count: 1 },
  { name: 'iFrameRate', type: 'float', count: 1 },
  { name: 'iFrame', type: 'int', count: 1 },
  { name: 'iChannelTime', type: 'float', count: 4 },
  { name: 'iChannelResolution', type: 'vec3', count: 4 },
  { name: 'iMouse', type: 'vec4', count: 1 },
  { name: 'iDate', type: 'vec4', count: 1 },
  { name: 'iSampleRate', type: 'float', count: 1 },
  { name: 'iCurrentCursor', type: 'vec4', count: 1 },
  { name: 'iPreviousCursor', type: 'vec4', count: 1 },
  { name: 'iCurrentCursorColor', type: 'vec4', count: 1 },
  { name: 'iPreviousCursorColor', type: 'vec4', count: 1 },
  { name: 'iCurrentCursorStyle', type: 'int', count: 1 },
  { name: 'iPreviousCursorStyle', type: 'int', count: 1 },
  { name: 'iCursorVisible', type: 'int', count: 1 },
  { name: 'iTimeCursorChange', type: 'float', count: 1 },
  { name: 'iTimeFocus', type: 'float', count: 1 },
  { name: 'iFocus', type: 'int', count: 1 },
  { name: 'iPalette', type: 'vec3', count: 256 },
  { name: 'iBackgroundColor', type: 'vec3', count: 1 },
  { name: 'iForegroundColor', type: 'vec3', count: 1 },
  { name: 'iCursorColor', type: 'vec3', count: 1 },
  { name: 'iCursorText', type: 'vec3', count: 1 },
  { name: 'iSelectionForegroundColor', type: 'vec3', count: 1 },
  { name: 'iSelectionBackgroundColor', type: 'vec3', count: 1 },
])

interface UniformTypeValues {
  readonly float: number
  readonly int: number
  readonly vec3: ShaderVector3
  readonly vec4: ShaderVector4
}

interface UniformCountValues<T> {
  readonly 1: T
  readonly 4: readonly [T, T, T, T]
  readonly 256: readonly T[]
}

type UniformValue<T extends (typeof UNIFORM_DEFINITIONS)[number]> = UniformCountValues<
  UniformTypeValues[T['type']]
>[T['count']]

export type ShaderUniformValues = {
  readonly [Field in (typeof UNIFORM_DEFINITIONS)[number] as Field['name']]: UniformValue<Field>
}

const COMPONENTS = { float: 1, int: 1, vec3: 3, vec4: 4 } satisfies Record<UniformType, number>

function align(offset: number, alignment: number): number {
  return Math.ceil(offset / alignment) * alignment
}

function uniformFields(): readonly ShaderUniformField[] {
  let end = 0
  return Object.freeze(
    UNIFORM_DEFINITIONS.map((definition) => {
      const components = COMPONENTS[definition.type]
      const array = definition.count > 1
      const alignment = array || components >= 3 ? 16 : 4
      const offset = align(end, alignment)
      const stride = array ? 16 : components * 4
      end = offset + stride * definition.count
      return Object.freeze({ ...definition, offset, stride })
    }),
  )
}

export const SHADER_UNIFORM_FIELDS = uniformFields()

function uniformByteLength(): number {
  let end = 0
  for (const field of SHADER_UNIFORM_FIELDS) {
    end = Math.max(end, field.offset + field.stride * field.count)
  }
  return align(end, 16)
}

export const SHADER_UNIFORM_BYTE_LENGTH = uniformByteLength()

function checkedNumber(value: unknown, integer: boolean, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`)
  }
  if (!integer && !Number.isFinite(Math.fround(value))) {
    throw new RangeError(`${name} must fit in a 32-bit float`)
  }
  if (integer && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)) {
    throw new RangeError(`${name} must be a signed 32-bit integer`)
  }
  return value
}

function writeValue(
  view: DataView,
  field: ShaderUniformField,
  value: unknown,
  index: number,
): void {
  const offset = field.offset + field.stride * index
  const components = COMPONENTS[field.type]
  if (components === 1) {
    const number = checkedNumber(value, field.type === 'int', field.name)
    if (field.type === 'int') view.setInt32(offset, number, true)
    if (field.type === 'float') view.setFloat32(offset, number, true)
    return
  }
  if (!Array.isArray(value) || value.length !== components) {
    throw new TypeError(`${field.name} must contain ${components} numbers per vector`)
  }
  for (let component = 0; component < components; component += 1) {
    const number = checkedNumber(value[component], false, field.name)
    view.setFloat32(offset + component * 4, number, true)
  }
}

function writeField(view: DataView, field: ShaderUniformField, value: unknown): void {
  if (field.count === 1) return writeValue(view, field, value, 0)
  if (!Array.isArray(value) || value.length !== field.count) {
    throw new TypeError(`${field.name} must contain ${field.count} entries`)
  }
  for (let index = 0; index < field.count; index += 1) {
    writeValue(view, field, value[index], index)
  }
}

const UNIFORM_NAMES = new Set(SHADER_UNIFORM_FIELDS.map((field) => field.name))
const DEFAULT_VALUES: Partial<ShaderUniformValues> = { iResolution: [0, 0, 1] }

function validateValues(values: Partial<ShaderUniformValues>): void {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new TypeError('Shader uniform values must be an object')
  }
  for (const name of Object.keys(values)) {
    if (!UNIFORM_NAMES.has(name)) throw new TypeError(`Unknown shader uniform: ${name}`)
  }
}

/** Packs the shared std140 ABI. Omitted values are zero; iResolution.z defaults to one. */
export function packShaderUniforms(
  values: Partial<ShaderUniformValues> = {},
  output: ArrayBuffer = new ArrayBuffer(SHADER_UNIFORM_BYTE_LENGTH),
): ArrayBuffer {
  validateValues(values)
  if (!(output instanceof ArrayBuffer) || output.byteLength !== SHADER_UNIFORM_BYTE_LENGTH) {
    throw new RangeError(
      `Shader uniform output must be a ${SHADER_UNIFORM_BYTE_LENGTH}-byte ArrayBuffer`,
    )
  }
  new Uint8Array(output).fill(0)
  const view = new DataView(output)
  for (const field of SHADER_UNIFORM_FIELDS) {
    const value: unknown = Reflect.get(values, field.name)
    const effectiveValue = value === undefined ? Reflect.get(DEFAULT_VALUES, field.name) : value
    if (effectiveValue === undefined) continue
    writeField(view, field, effectiveValue)
  }
  return output
}
