import {
  type AbiField,
  type AbiLayout,
  type AbiLayouts,
  type BridgeWasmExports,
  ClipboardWriteResult,
  type GhosttyWasmExports,
  SystemOption,
  TerminalOption,
} from './abi.js'
import { assertGhosttyResult, createGhosttyError } from './error.js'
import { type WasmAllocation, WasmMemory, requireLayout } from './memory.js'
import type {
  ClipboardRepresentation,
  ClipboardWrite,
  DecodedPng,
  DeviceAttributes,
  TerminalEffects,
  TerminalSize,
} from './types.js'

const bridgeNames = [
  'bridge_write_pty',
  'bridge_bell',
  'bridge_color_scheme',
  'bridge_clipboard_write',
  'bridge_device_attributes',
  'bridge_size',
  'bridge_xtversion',
  'bridge_title_changed',
  'bridge_decode_png',
] as const

const decoder = new TextDecoder()

const defaultDeviceAttributes: DeviceAttributes = {
  primary: {
    conformanceLevel: 62,
    features: [1, 6, 22],
  },
  secondary: {
    deviceType: 1,
    firmwareVersion: 1,
    romCartridge: 0,
  },
  tertiary: {
    unitId: 0,
  },
}

interface BridgeIndexes {
  bridge_bell: number
  bridge_clipboard_write: number
  bridge_color_scheme: number
  bridge_decode_png: number
  bridge_device_attributes: number
  bridge_size: number
  bridge_title_changed: number
  bridge_write_pty: number
  bridge_xtversion: number
}

interface TerminalTarget {
  effects: TerminalEffects
  size: TerminalSize
  version: WasmAllocation
}

function requireField(layout: AbiLayout, name: string): AbiField {
  const field = layout.fields[name]
  if (field) return field
  throw createGhosttyError('ghostty_type_json', `Required ABI field is missing: ${name}`)
}

function installBridge(table: WebAssembly.Table, exports: BridgeWasmExports): BridgeIndexes {
  const first = table.grow(bridgeNames.length)
  const indexes = {} as BridgeIndexes
  for (const [offset, name] of bridgeNames.entries()) {
    const callback = exports[name]
    if (typeof callback !== 'function') {
      throw createGhosttyError('bridge.instantiate', `Bridge export is not callable: ${name}`)
    }
    table.set(first + offset, callback)
    indexes[name] = first + offset
  }
  return indexes
}

export class CallbackBridge {
  readonly imports: WebAssembly.Imports
  private readonly clipboardContentLayout: AbiLayout
  private readonly clipboardWriteReplyLayout: AbiLayout
  private readonly clipboardWriteLayout: AbiLayout
  private readonly exports: GhosttyWasmExports
  private readonly layouts: AbiLayouts
  private readonly memory: WasmMemory
  private readonly stringLayout: AbiLayout
  private readonly sysImageLayout: AbiLayout
  private readonly targets = new Map<number, TerminalTarget>()
  private indexes?: BridgeIndexes
  private pngDecoder?: (bytes: Uint8Array) => DecodedPng | undefined

  constructor(exports: GhosttyWasmExports, layouts: AbiLayouts) {
    this.exports = exports
    this.layouts = layouts
    this.memory = new WasmMemory(exports)
    this.clipboardContentLayout = requireLayout(layouts, 'GhosttyClipboardContent')
    this.clipboardWriteReplyLayout = requireLayout(layouts, 'GhosttyClipboardWriteReply')
    this.clipboardWriteLayout = requireLayout(layouts, 'GhosttyClipboardWrite')
    this.stringLayout = requireLayout(layouts, 'GhosttyString')
    this.sysImageLayout = requireLayout(layouts, 'GhosttySysImage')
    this.imports = {
      env: {
        bell: (...args: number[]) => this.bell(...args),
        clipboard_write: (...args: number[]) => this.clipboardWrite(...args),
        color_scheme: (...args: number[]) => this.colorScheme(...args),
        decode_png: (...args: number[]) => this.decodePng(...args),
        device_attributes: (...args: number[]) => this.deviceAttributes(...args),
        size: (...args: number[]) => this.size(...args),
        title_changed: (...args: number[]) => this.titleChanged(...args),
        write_pty: (...args: number[]) => this.writePty(...args),
        xtversion: (...args: number[]) => this.xtversion(...args),
      },
    }
  }

  get terminalCount(): number {
    return this.targets.size
  }

  install(exports: BridgeWasmExports): void {
    this.indexes = installBridge(this.exports.__indirect_function_table, exports)
  }

  configurePngDecoder(decoder?: (bytes: Uint8Array) => DecodedPng | undefined): void {
    const indexes = this.requireIndexes()
    this.pngDecoder = decoder
    const callback = decoder ? indexes.bridge_decode_png : 0
    assertGhosttyResult(
      'ghostty_sys_set(DECODE_PNG)',
      this.exports.ghostty_sys_set(SystemOption.DecodePng, callback),
    )
  }

  registerTerminal(terminal: number, effects: TerminalEffects, size: TerminalSize): void {
    const version = this.memory.allocateBytes(effects.xtversion ?? 'ghostty-webgpu')
    this.targets.set(terminal, { effects, size, version })
    this.installTerminalCallbacks(terminal)
  }

  updateTerminalSize(terminal: number, size: TerminalSize): void {
    const target = this.targets.get(terminal)
    if (!target) return
    target.size = size
  }

  unregisterTerminal(terminal: number): void {
    const target = this.targets.get(terminal)
    if (!target) return
    this.targets.delete(terminal)
    this.memory.freeBytes(target.version)
  }

  private requireIndexes(): BridgeIndexes {
    if (this.indexes) return this.indexes
    throw createGhosttyError('bridge.install', 'The callback bridge has not been installed')
  }

  private installTerminalCallbacks(terminal: number): void {
    const indexes = this.requireIndexes()
    const callbacks: readonly [number, number][] = [
      [TerminalOption.WritePty, indexes.bridge_write_pty],
      [TerminalOption.Bell, indexes.bridge_bell],
      [TerminalOption.Xtversion, indexes.bridge_xtversion],
      [TerminalOption.TitleChanged, indexes.bridge_title_changed],
      [TerminalOption.Size, indexes.bridge_size],
      [TerminalOption.ColorScheme, indexes.bridge_color_scheme],
      [TerminalOption.DeviceAttributes, indexes.bridge_device_attributes],
      [TerminalOption.ClipboardWrite, indexes.bridge_clipboard_write],
    ]
    for (const [option, callback] of callbacks) {
      assertGhosttyResult(
        `ghostty_terminal_set(${option})`,
        this.exports.ghostty_terminal_set(terminal, option, callback),
      )
    }
  }

  private writePty(terminal = 0, _userdata = 0, pointer = 0, length = 0): void {
    const target = this.targets.get(terminal)
    if (!target?.effects.writePty) return
    const bytes = Uint8Array.from(this.memory.bytes.subarray(pointer, pointer + length))
    target.effects.writePty(bytes)
  }

  private bell(terminal = 0): void {
    this.targets.get(terminal)?.effects.bell?.()
  }

  private colorScheme(terminal = 0, _userdata = 0, out = 0): number {
    const colorScheme = this.targets.get(terminal)?.effects.colorScheme
    if (colorScheme === undefined || out === 0) return 0
    this.memory.view.setInt32(out, colorScheme, true)
    return 1
  }

  private clipboardWrite(terminal = 0, _userdata = 0, pointer = 0): void {
    const effect = this.targets.get(terminal)?.effects.clipboardWrite
    const write = this.readClipboardWrite(pointer)
    if (!write) {
      this.replyClipboardWrite(pointer, ClipboardWriteResult.InvalidData)
      return
    }
    const result = effect?.(write) ?? ClipboardWriteResult.Denied
    this.replyClipboardWrite(pointer, result)
  }

  private deviceAttributes(terminal = 0, _userdata = 0, out = 0): number {
    const target = this.targets.get(terminal)
    if (!target) return 0
    this.writeDeviceAttributes(out, target.effects.deviceAttributes ?? defaultDeviceAttributes)
    return 1
  }

  private size(terminal = 0, _userdata = 0, out = 0): number {
    const target = this.targets.get(terminal)
    if (!target) return 0
    this.writeSize(out, target.size)
    return 1
  }

  private xtversion(out = 0, terminal = 0): void {
    const target = this.targets.get(terminal)
    if (!target) return
    this.memory.view.setUint32(
      out + requireField(this.stringLayout, 'ptr').offset,
      target.version.pointer,
      true,
    )
    this.memory.view.setUint32(
      out + requireField(this.stringLayout, 'len').offset,
      target.version.length,
      true,
    )
  }

  private titleChanged(terminal = 0): void {
    this.targets.get(terminal)?.effects.titleChanged?.()
  }

  private decodePng(_userdata = 0, allocator = 0, data = 0, length = 0, out = 0): number {
    if (!this.pngDecoder) return 0
    const input = Uint8Array.from(this.memory.bytes.subarray(data, data + length))
    const decoded = this.pngDecoder(input)
    if (!decoded) return 0
    if (!this.isValidImage(decoded)) return 0
    return this.writeDecodedImage(allocator, out, decoded)
  }

  private isValidImage(image: DecodedPng): boolean {
    if (!Number.isInteger(image.width) || image.width <= 0) return false
    if (!Number.isInteger(image.height) || image.height <= 0) return false
    return image.pixels.length === image.width * image.height * 4
  }

  private writeDecodedImage(allocator: number, out: number, image: DecodedPng): number {
    const pixels = this.exports.ghostty_alloc(allocator, image.pixels.length)
    if (pixels === 0) return 0
    this.memory.bytes.set(image.pixels, pixels)
    this.memory.view.setUint32(
      out + requireField(this.sysImageLayout, 'width').offset,
      image.width,
      true,
    )
    this.memory.view.setUint32(
      out + requireField(this.sysImageLayout, 'height').offset,
      image.height,
      true,
    )
    this.memory.view.setUint32(out + requireField(this.sysImageLayout, 'data').offset, pixels, true)
    this.memory.view.setUint32(
      out + requireField(this.sysImageLayout, 'data_len').offset,
      image.pixels.length,
      true,
    )
    return 1
  }

  private readClipboardWrite(pointer: number): ClipboardWrite | undefined {
    if (!this.isReadable(pointer, this.clipboardWriteLayout.size)) return undefined
    const reportedSize = this.memory.view.getUint32(
      pointer + requireField(this.clipboardWriteLayout, 'size').offset,
      true,
    )
    if (reportedSize < this.clipboardWriteLayout.size) return undefined
    const contentsPointer = this.memory.view.getUint32(
      pointer + requireField(this.clipboardWriteLayout, 'contents').offset,
      true,
    )
    const contentsLength = this.memory.view.getUint32(
      pointer + requireField(this.clipboardWriteLayout, 'contents_len').offset,
      true,
    )
    const contents = this.readClipboardContents(contentsPointer, contentsLength)
    if (!contents) return undefined
    return {
      contents,
      location: this.memory.view.getInt32(
        pointer + requireField(this.clipboardWriteLayout, 'location').offset,
        true,
      ) as ClipboardWrite['location'],
    }
  }

  private replyClipboardWrite(pointer: number, result: ClipboardWriteResult): void {
    if (!this.isReadable(pointer, this.clipboardWriteLayout.size)) return
    const replyIndex = this.memory.view.getUint32(
      pointer + requireField(this.clipboardWriteLayout, 'reply').offset,
      true,
    )
    const reply = this.exports.__indirect_function_table.get(replyIndex)
    if (typeof reply !== 'function') return
    const response = this.memory.allocate(this.clipboardWriteReplyLayout.size)
    try {
      this.memory.view.setUint32(
        response + requireField(this.clipboardWriteReplyLayout, 'size').offset,
        this.clipboardWriteReplyLayout.size,
        true,
      )
      this.memory.view.setInt32(
        response + requireField(this.clipboardWriteReplyLayout, 'result').offset,
        result,
        true,
      )
      reply(pointer, response)
    } finally {
      this.memory.free(response, this.clipboardWriteReplyLayout.size)
    }
  }

  private readClipboardContents(
    pointer: number,
    length: number,
  ): readonly ClipboardRepresentation[] | undefined {
    if (length === 0) return []
    if (!this.isReadable(pointer, length * this.clipboardContentLayout.size)) return undefined
    const contents: ClipboardRepresentation[] = []
    for (let index = 0; index < length; index += 1) {
      const contentPointer = pointer + index * this.clipboardContentLayout.size
      const content = this.readClipboardContent(contentPointer)
      if (!content) return undefined
      contents.push(content)
    }
    return contents
  }

  private readClipboardContent(pointer: number): ClipboardRepresentation | undefined {
    const mimePointer = pointer + requireField(this.clipboardContentLayout, 'mime').offset
    const dataPointer = pointer + requireField(this.clipboardContentLayout, 'data').offset
    const mime = this.copyBorrowedString(mimePointer)
    if (!mime) return undefined
    const data = this.copyBorrowedString(dataPointer)
    if (!data) return undefined
    return { data, mime: decoder.decode(mime) }
  }

  private copyBorrowedString(pointer: number): Uint8Array | undefined {
    if (!this.isReadable(pointer, this.stringLayout.size)) return undefined
    const data = this.memory.view.getUint32(
      pointer + requireField(this.stringLayout, 'ptr').offset,
      true,
    )
    const length = this.memory.view.getUint32(
      pointer + requireField(this.stringLayout, 'len').offset,
      true,
    )
    if (length === 0) return new Uint8Array()
    if (!this.isReadable(data, length)) return undefined
    return Uint8Array.from(this.memory.bytes.subarray(data, data + length))
  }

  private isReadable(pointer: number, length: number): boolean {
    if (!Number.isSafeInteger(length) || length < 0) return false
    if (!Number.isSafeInteger(pointer) || pointer <= 0) return false
    return pointer + length <= this.memory.bytes.length
  }

  private writeSize(pointer: number, size: TerminalSize): void {
    const layout = requireLayout(this.layouts, 'GhosttySizeReportSize')
    this.memory.view.setUint16(pointer + requireField(layout, 'rows').offset, size.rows, true)
    this.memory.view.setUint16(pointer + requireField(layout, 'columns').offset, size.columns, true)
    this.memory.view.setUint32(
      pointer + requireField(layout, 'cell_width').offset,
      size.cellWidth,
      true,
    )
    this.memory.view.setUint32(
      pointer + requireField(layout, 'cell_height').offset,
      size.cellHeight,
      true,
    )
  }

  private writeDeviceAttributes(pointer: number, attributes: DeviceAttributes): void {
    const root = requireLayout(this.layouts, 'GhosttyDeviceAttributes')
    const primaryLayout = requireLayout(this.layouts, 'GhosttyDeviceAttributesPrimary')
    const secondaryLayout = requireLayout(this.layouts, 'GhosttyDeviceAttributesSecondary')
    const tertiaryLayout = requireLayout(this.layouts, 'GhosttyDeviceAttributesTertiary')
    const primary = pointer + requireField(root, 'primary').offset
    const secondary = pointer + requireField(root, 'secondary').offset
    const tertiary = pointer + requireField(root, 'tertiary').offset
    const features = attributes.primary.features.slice(0, 64)

    this.memory.view.setUint16(
      primary + requireField(primaryLayout, 'conformance_level').offset,
      attributes.primary.conformanceLevel,
      true,
    )
    const featurePointer = primary + requireField(primaryLayout, 'features').offset
    for (const [index, feature] of features.entries()) {
      this.memory.view.setUint16(featurePointer + index * 2, feature, true)
    }
    this.memory.view.setUint32(
      primary + requireField(primaryLayout, 'num_features').offset,
      features.length,
      true,
    )
    this.memory.view.setUint16(
      secondary + requireField(secondaryLayout, 'device_type').offset,
      attributes.secondary.deviceType,
      true,
    )
    this.memory.view.setUint16(
      secondary + requireField(secondaryLayout, 'firmware_version').offset,
      attributes.secondary.firmwareVersion,
      true,
    )
    this.memory.view.setUint16(
      secondary + requireField(secondaryLayout, 'rom_cartridge').offset,
      attributes.secondary.romCartridge,
      true,
    )
    this.memory.view.setUint32(
      tertiary + requireField(tertiaryLayout, 'unit_id').offset,
      attributes.tertiary.unitId,
      true,
    )
  }
}
