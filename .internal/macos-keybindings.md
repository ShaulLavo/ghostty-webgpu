# macOS terminal editing defaults

Owner report and browser reproduction, 2026-10-28.

## Source comparison

- Native Ghostty defines five macOS natural editing bindings in [Config.zig at the pinned core revision](https://github.com/ghostty-org/ghostty/blob/7b11f3dca034d8d24369ad3856afe57946d7902a/src/config/Config.zig#L7330). Cmd+Left sends `01`, Cmd+Right sends `05`, Cmd+Backspace sends `15`, and Option+Left and Option+Right send `1b 62` and `1b 66`. These are text actions that bypass extended keyboard protocols.
- [xterm.js 6.0.0 core](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/input/Keyboard.ts#L84) does not implement these Command editing defaults. Meta+Left and Meta+Right produce no encoded key. Meta+Backspace follows the ordinary Backspace branch and sends DEL. The [browser owner](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/browser/CoreBrowserTerminal.ts) calls this encoder after its custom key handler.
- [VS Code's send-sequence contribution](https://github.com/microsoft/vscode/blob/a3ad284029f2b1c907c7c7e00039c228fe24511e/src/vs/workbench/contrib/terminalContrib/sendSequence/browser/terminal.sendSequence.contribution.ts#L284) registers macOS terminal keybindings for Cmd+Left, Cmd+Right, and Cmd+Backspace that send Ctrl-A, Ctrl-E, and Ctrl-U. It also maps Option+Left and Option+Right to Escape-b and Escape-f. These are VS Code bindings layered above xterm.js, including in its browser workbench.

Browser terminals can supply these platform defaults above their VT encoder, just as VS Code does. ghostty-webgpu follows its native namesake's defaults in the shared DOM input owner. A shell should consume the resulting conventional bytes, without interpreting a platform-specific Command modifier.

## Browser reproduction

Chromium 154 on the PC, Mac user agent and `navigator.platform = 'MacIntel'` installed before navigation, live https://fxj6.sprockt.dev/ with ghostty-webgpu v0.3.25:

1. Type `echo ABC`, press Cmd+Left, then type `X`. Observed `$ echo ABCX`, expected `$ Xecho ABC`.
2. Press Cmd+Right, then type `Y`. Observed `$ echo ABCXY`.
3. Press Cmd+Backspace. Observed `$ echo ABCX`, expected an empty prompt.

The fix covers both main-thread and worker terminals, repeats, and key releases with legacy and Kitty keyboard protocols. Other operating systems keep their VT encoding path. Additional modifiers, composition, disabled input, and input-owner claims retain precedence.
