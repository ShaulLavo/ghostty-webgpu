import type * as Reference from '@xterm/xterm'
import { Terminal as TargetTerminal } from '../../index.js'
import type * as Target from '../../index.js'
import { expect, expectTypeOf, test } from 'vitest'

test('exports the facade from the public package entry point', () => {
  expect(TargetTerminal).toBeTypeOf('function')
})

test('matches the released xterm 6.0.0 public type shapes', () => {
  expectTypeOf<Target.FontWeight>().toEqualTypeOf<Reference.FontWeight>()
  expectTypeOf<Target.LogLevel>().toEqualTypeOf<Reference.LogLevel>()
  expectTypeOf<Target.ITerminalOptions>().toEqualTypeOf<Reference.ITerminalOptions>()
  expectTypeOf<Target.ITerminalInitOnlyOptions>().toEqualTypeOf<Reference.ITerminalInitOnlyOptions>()
  expectTypeOf<Target.ITheme>().toEqualTypeOf<Reference.ITheme>()
  expectTypeOf<Target.IWindowsPty>().toEqualTypeOf<Reference.IWindowsPty>()
  expectTypeOf<Target.ILogger>().toEqualTypeOf<Reference.ILogger>()
  expectTypeOf<Target.IDisposable>().toEqualTypeOf<Reference.IDisposable>()
  expectTypeOf<Target.IEvent<string>>().toEqualTypeOf<Reference.IEvent<string>>()
  expectTypeOf<Target.IDisposableWithEvent>().toEqualTypeOf<Reference.IDisposableWithEvent>()
  expectTypeOf<Target.IMarker>().toEqualTypeOf<Reference.IMarker>()
  expectTypeOf<Target.IDecoration>().toEqualTypeOf<Reference.IDecoration>()
  expectTypeOf<Target.IDecorationOverviewRulerOptions>().toEqualTypeOf<Reference.IDecorationOverviewRulerOptions>()
  expectTypeOf<Target.IDecorationOptions>().toEqualTypeOf<Reference.IDecorationOptions>()
  expectTypeOf<Target.ILocalizableStrings>().toEqualTypeOf<Reference.ILocalizableStrings>()
  expectTypeOf<Target.IOverviewRulerOptions>().toEqualTypeOf<Reference.IOverviewRulerOptions>()
  expectTypeOf<Target.IWindowOptions>().toEqualTypeOf<Reference.IWindowOptions>()
  expectTypeOf<Target.IViewportRange>().toEqualTypeOf<Reference.IViewportRange>()
  expectTypeOf<Target.IViewportRangePosition>().toEqualTypeOf<Reference.IViewportRangePosition>()
  expectTypeOf<Target.ILinkHandler>().toEqualTypeOf<Reference.ILinkHandler>()
  expectTypeOf<Target.ILinkProvider>().toEqualTypeOf<Reference.ILinkProvider>()
  expectTypeOf<Target.ILink>().toEqualTypeOf<Reference.ILink>()
  expectTypeOf<Target.ILinkDecorations>().toEqualTypeOf<Reference.ILinkDecorations>()
  expectTypeOf<Target.IBufferRange>().toEqualTypeOf<Reference.IBufferRange>()
  expectTypeOf<Target.IBufferCellPosition>().toEqualTypeOf<Reference.IBufferCellPosition>()
  expectTypeOf<Target.IBuffer>().toEqualTypeOf<Reference.IBuffer>()
  expectTypeOf<Target.IBufferElementProvider>().toEqualTypeOf<Reference.IBufferElementProvider>()
  expectTypeOf<Target.IBufferNamespace>().toEqualTypeOf<Reference.IBufferNamespace>()
  expectTypeOf<Target.IBufferLine>().toEqualTypeOf<Reference.IBufferLine>()
  expectTypeOf<Target.IBufferCell>().toEqualTypeOf<Reference.IBufferCell>()
  expectTypeOf<Target.IFunctionIdentifier>().toEqualTypeOf<Reference.IFunctionIdentifier>()
  expectTypeOf<Target.IParser>().toEqualTypeOf<Reference.IParser>()
  expectTypeOf<Target.IUnicodeVersionProvider>().toEqualTypeOf<Reference.IUnicodeVersionProvider>()
  expectTypeOf<Target.IUnicodeHandling>().toEqualTypeOf<Reference.IUnicodeHandling>()
  expectTypeOf<Target.IModes>().toEqualTypeOf<Reference.IModes>()
})

test('the facade is assignable to the released xterm Terminal surface', () => {
  expectTypeOf<TargetTerminal>().toMatchTypeOf<Reference.Terminal>()
})
