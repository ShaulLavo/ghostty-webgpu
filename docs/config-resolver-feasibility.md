# Ghostty config resolver feasibility

## 1. Summary

Decision: **FAIL**.

The accepted fixed-candidate enumeration removes the original write hazard. A proof helper can
enumerate Ghostty's legacy/current default paths, pass each path directly to
`Config.loadOptionalFile`, and never call `Config.loadDefaultFiles` or `Config.load`. On native
Linux x64 it returned `not-configured` for an empty isolated home without creating a file, and it
resolved the mandatory `Afterglow` / `3024 Day` pair correctly through Ghostty.

The next ordered gate fails. At the pinned revision, Config depends on private global process state.
The only official initializer for a standalone tool is `global.init(.tool)`. The `.tool` tag skips
Ghostty action detection only; initialization still calls `glslang.init()` for shader compilation.
Upstream `SharedDeps.add` unconditionally imports and links glslang, SPIRV-Cross, cimgui, renderer,
font, image, PTY, and embedded-font dependencies. The renderer backend enum has no `none` value.
This is Plan 065's explicit Milestone 1 STOP condition: correct config initialization necessarily
retains GUI-only runtime code. Removing it requires changing or copying the upstream build/global
boundary, neither of which is authorized.

No maintained fork, upstream patch, installed Ghostty, TypeScript parser, OS-theme guess, or weaker
target matrix was substituted. The four native target rows remain incomplete after the decisive
global failure; none is presented as passing.

## 2. Exact inputs and proof command

- Platform reconciliation base: `4b25f1ab28eab2da499ac0cf0fcc633af1ea6640`.
- Platform execution checkout observed: `6369576de6b81474e2c80ae327512dcf2c6c9a42`.
- `ghostty-webgpu`: `https://github.com/ShaulLavo/ghostty-webgpu.git` at
  `3c3e07edef23cdbbe141410432e89276cb6504b2`.
- Ghostty: `https://github.com/ghostty-org/ghostty.git` at
  `c8554f28e0efe2f5595f32020371c34b25ec628f`.
- Canonical `ghostty-upstream-tree-v1` SHA-256:
  `63d2b0c41531162a70b838369c0c225745e167495763ebbd0bc2fe546976a2bb` over 5,864 entries.
- Compiler: Zig `0.16.0` exactly. The official Linux x64 archive is 55,478,392 bytes with SHA-256
  `70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00`; its extracted executable
  has SHA-256 `2317bbb91798556d9d0f38aabdac23db83f0979b25f767259ae474546724087c`.
- Shared `SOURCE_DATE_EPOCH`: `1787590337`, the pinned Ghostty commit timestamp.
- Stop-recipe SHA-256: `3076a879ef28018257392dbaa7fa8deb995335f33e342188aa4118829b25f734`.
- Built-in theme archive: `https://deps.files.ghostty.org/ghostty-themes-release-20260810-152212-0173c3c.tgz`,
  78,218 bytes, SHA-256
  `ea9878471420ee5b12e7f2ff480099c954ea50e573a1bdf83f43e105c9be63f0`.
- Runner images: none. The global build-boundary gate failed before a four-target PASS recipe or
  workflow run could be authorized.

The non-writing decision command was:

```text
bun scripts/config-resolver-proof/run.ts --upstream <detached-pinned-checkout> --zig <official-zig-0.16.0>/zig --zig-archive <official-zig-0.16.0.tar.xz> --evidence <new-temporary-evidence.json>
```

It recomputed the pinned Git tree, verified exact Zig archive and executable bytes, required a clean
detached checkout, and emitted `official-config-init-retains-gui-runtime`.

The successful exploratory native Linux x64 build used a temporary overlay of symlinks into the
clean checkout. The overlay contained only the proof `build.zig` and `main.zig`; it did not copy or
modify Ghostty source.

```text
/tmp/plan-065.fOoEIf/zig-x86_64-linux-0.16.0/zig build --prefix /tmp/plan-065-overlay.gSS2Ns/out --cache-dir /tmp/plan-065.fOoEIf/zig-cache --global-cache-dir /tmp/plan-065.fOoEIf/zig-global-cache -Doptimize=ReleaseSafe -Dtarget=x86_64-linux-gnu
```

Gate 0 package hashes were unchanged at completion:

| Input | SHA-256 |
| --- | --- |
| `ghostty-vt.wasm` | `dfb171587bc11b6610fb95d3b583926d51287f5d6e528c45ff2aa05218608a97` |
| `bridge.wasm` | `47fae389c94f2545b2026d756256272b65f978d97feabae21b9171ad4b54b63f` |
| `scripts/build-wasm.ts` | `c3132eb6cf210aa841713972225a39e45658154199572df6a237d65206c85d99` |

## 3. Exact build, module, generated-source, and resource graph

The existing downstream `src/build/GhosttyZig.zig` boundary exposes only `vt` and `vt_c`, rooted at
`src/lib_vt.zig`. Those modules use terminal artifact mode `lib`; `src/global.zig` deliberately
rejects that mode. Config therefore cannot be added through the package's current downstream
boundary without changing an API.

The smallest buildable official application-side graph found was:

```text
proof executable
  -> src/config/Config.zig
    -> generated build_config.zig and build_options
    -> generated help_strings, Unicode tables, symbol tables, and framedata
    -> config file, recursive include, conditional, theme, CLI, path, and formatter modules
    -> terminal color and official generate256Color implementation
    -> src/global.zig
  -> global.init(.tool)
    -> threaded std.Io and environment snapshot
    -> temp-directory discovery, locale, signals, resource limits, crash boundary
    -> glslang.init and oniguruma.init
    -> app-runtime resource discovery and optional i18n
  -> src/build/SharedDeps.zig
    -> uucode, locale/PTY C translations, help/unicode/framedata generators
    -> freetype, HarfBuzz, fontconfig, libpng, zlib, libxml2
    -> oniguruma, glslang, SPIRV-Cross
    -> OpenGL/glad, stb, libxev, vaxis, wuffs, z2d, zf, dcimgui
    -> embedded JetBrains Mono and Nerd Font files
```

The proof set `app_runtime = .none`, `emit_lib_vt = false`, and disabled sentry, SIMD, i18n, X11,
and Wayland. Those supported options remove the application runtime integrations they govern, but
they do not guard the shared renderer graph. In particular:

- `global.init(.tool)` reaches `try glslang.init()` unconditionally;
- `SharedDeps.add` always adds the `glslang`, `spirv_cross`, and `dcimgui` dependencies;
- it documents that freetype is always included for Dear ImGui;
- every executable receives OpenGL/glad sources and embedded font modules; and
- `renderer/backend.zig` offers only `opengl`, `metal`, and `webgl`, not a resolver-safe `none`.

The native Linux binary retained glslang parser/compiler symbols, including
`glslang::TParseContext`, after the official dependency graph linked. It was 56,230,152 bytes
unstripped with SHA-256
`b5b5d24fa79c1d35a42756574539e80916ff2b0122c8fe4da2acec33969193e7`. GNU strip 2.47 reduced
the exploratory binary to 8,066,896 bytes with SHA-256
`4a936b5d728cf4ee069461b15fb167d753c390f9f06a5fe27ec54ec4c06362a5`.

`readelf -d` reported only `libm.so.6`, `libc.so.6`, `ld-linux-x86-64.so.2`, `libpthread.so.0`, and
`libdl.so.2` as shared dependencies because the GUI/compiler libraries were statically retained.
Static linkage changes packaging, not the fact that shader/compiler initialization is in the
resolver's runtime call graph.

Themes are runtime data under `share/ghostty/themes` in a normal Ghostty resource tree. The proof
used the exact `iterm2_themes` archive pinned in `build.zig.zon` through an isolated explicit
resource directory. No package layout is proposed because the build boundary already fails.

## 4. Initialization, conditional transition, ownership, and deinitialization

The demonstrated sequence was:

1. call `global.init(.tool)` and retain `global.deinit` for process teardown;
2. allocate `Config.default`;
3. enumerate legacy XDG then current XDG using upstream path builders;
4. on macOS, additionally enumerate legacy Application Support then upstream
   `preferredAppSupportPath`, skipping the second load when it equals legacy;
5. pass candidates only to `Config.loadOptionalFile`;
6. return `not-configured` if none loaded, without calling the template-writing aggregate;
7. call `loadRecursiveFiles` and `finalize` after at least one successful read;
8. extract the light profile;
9. call `changeConditionalState(.{ .theme = .dark })` and use its new owned Config; or, on `null`,
   call `Config.clone` to make the dark profile independently owned; and
10. deinitialize dark, light, then global state.

This ownership sequence is adequate. The failure occurs before Config semantics: the official
global initializer necessarily performs renderer-only initialization. A local partial initializer,
fake `glslang` import, copied build module, or upstream source patch would be a different boundary.

## 5. Semantic fixture results

One bounded smoke fixture was executed before the build-graph audit reached the STOP condition. It
placed only a normal current-XDG config containing
`theme = dark:Afterglow,light:3024 Day`, opacity `0.9`, and blur radius `20`. Ghostty emitted two
256-entry palettes and the mandated effective values:

| Profile | Background | Foreground | Cursor text | Palette assertions |
| --- | --- | --- | --- | --- |
| light | `#f7f7f7` | `#4a4543` | `#f7f7f7` | 0 `#090300`, 15 `#f7f7f7` |
| dark | `#212121` | `#d0d0d0` | `#151515` | 0 `#151515`, 6 `#7dd6cf` |

Both retained opacity `0.9` and radius `20`; diagnostic count was zero. Output was one 13,729-byte
JSON value and stderr was empty. Palette extraction calls Ghostty's own `generate256Color` with the
original value and explicit-entry mask only when the pinned terminal path would do so.

The remaining mandatory include/reset/cycle, file theme, named color, palette-generation,
no-conditional ownership, diagnostic, dynamic color, surface variant, and Display-P3 vectors were
not promoted to evidence. Plan 065 orders the GUI-runtime stop before those fixture gates, and a
partial semantic smoke test cannot override it.

## 6. No-write and privacy results

The accepted divergence is structurally read-only. The helper never calls `Config.load` or
`loadDefaultFiles`; its only default-file operation is `loadOptionalFile`. Deleting or renaming a
candidate after enumeration can therefore produce `not_found` but cannot transfer control to
`writeConfigTemplate`.

An empty isolated Linux home/config root returned the fixed 113-byte `not-configured` result with
empty stderr and no entries created beneath either root. The full location-by-location delete and
rename race fixture matrix was not executed after the earlier build-boundary STOP, so those strict
evidence fields remain incomplete rather than inferred as passing.

The smoke output contained only fixed keys/enums, numbers, RGB values, the pinned revision, and a
diagnostic count. No config path, theme name, config line, environment value, diagnostic message,
or native error appeared. Full sentinel leakage evidence remains incomplete for the same ordered
gate reason.

## 7. Four-target evidence

The exact required matrix remains intact. A global build-boundary failure makes all native rows
incomplete; no cross-build or local Linux smoke run is substituted for native four-target evidence.

| Target | Runner | Artifact hash / bytes | Dependencies | Native execution | Semantics | No-write | Compatibility | Relocation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `darwin-arm64` | not run after global STOP | `null` / 0 | incomplete | incomplete | incomplete | incomplete | incomplete | incomplete |
| `darwin-x64` | not run after global STOP | `null` / 0 | incomplete | incomplete | incomplete | incomplete | incomplete | incomplete |
| `linux-arm64` | not run after global STOP | `null` / 0 | incomplete | incomplete | incomplete | incomplete | incomplete | incomplete |
| `linux-x64` | not run after global STOP | `null` / 0 | incomplete | incomplete | incomplete | incomplete | incomplete | incomplete |

No workflow was added or run. A workflow would be useful only after the global STOP condition was
removed upstream, and committing/pushing one was explicitly unauthorized.

## 8. Proposed package layout, size ceiling, and runtime selection

There is no viable package layout or runtime selection algorithm under the accepted boundary at
this pin. Shipping the 8.1 MB stripped exploratory binary would also ship and initialize
shader/compiler and renderer support that the resolver neither needs nor is permitted to retain.

The strict JSON's positive one-byte ceiling values are early-FAIL sentinels required by the fixed
evidence shape. They are pending, unaccepted, and are not package proposals. Plan 066 remains
blocked and must not convert the exploratory binary into a release candidate.

## 9. Known fidelity degradations and fallback recommendations

No fidelity degradation addresses this failure. The read-only search divergence is accepted and
works; the blocked part is upstream process/build modularity.

The narrow recommendation is an upstream auxiliary boundary that initializes Config I/O,
environment, resources, and oniguruma without shader, renderer, font, image, PTY, embedded-font, or
GUI dependencies. It also needs an official shared-build function that wires exactly those modules.
If such an API lands upstream and is incorporated into the pinned package revision, Plan 065 can be
reproposed without a fork. This plan does not authorize creating that patch locally.

## 10. Blockers and residual risks

- Blocking fact: `global.init(.tool)` unconditionally initializes glslang for shader compilation.
- Blocking fact: the official shared executable graph unconditionally links glslang,
  SPIRV-Cross, cimgui, renderer/font/image support, and embedded fonts.
- Blocking fact: no official renderer-free backend or Config-specific initializer exists at the
  pin; removing those dependencies requires upstream-source or upstream-build changes.
- The full semantic, race, privacy, Display-P3, native matrix, compatibility, and relocation gates
  remain incomplete because the plan stopped at the first decisive ordered failure.
- The requested never-nester skill file was absent from this Linux host and no alternate copy was
  discoverable. The equivalent guard-clause, nesting-depth, loop-inversion, and no-`else` rules in
  the repository instructions were applied.
- Existing dirty DOM/input and Platform Plan 055 work was preserved outside the proof diff.

Decision: FAIL
