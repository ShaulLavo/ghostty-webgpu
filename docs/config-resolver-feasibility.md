# Ghostty config resolver feasibility

## 1. Summary

Decision: **FAIL**.

The two operator-accepted divergences are viable. The proof can enumerate fixed default candidates
instead of calling Ghostty's template-writing aggregate, and the resulting 8.3 MB stripped helper
can be treated as a platform-specific optional host dependency. The retained GUI/shader graph is
therefore measured packaging weight, not this decision's blocker.

The decisive no-write gate fails on macOS. Both pinned Application Support candidate builders reach
`src/os/macos.zig::commonDir`, which sends Foundation
`URLForDirectory:inDomain:appropriateForURL:create:error:` with `create` set to `true`. Candidate
discovery can therefore create the Application Support directory under an otherwise empty isolated
home before the helper attempts to open a config. This violates the required structural guarantee
that config discovery creates no file or directory.

Pre-creating that directory in the fixture would hide the write. Reimplementing the macOS candidate
path with `HOME`, another Foundation call, or copied Ghostty logic would be a third divergence that
was not authorized. No TypeScript parser, installed Ghostty, maintained fork, upstream patch, or
weaker target matrix was substituted. The four native rows remain incomplete after the global
failure and Plans 066–067 remain blocked.

## 2. Exact inputs and proof commands

- Authorized reconciliation bases: Platform `4b25f1ab28eab2da499ac0cf0fcc633af1ea6640` and
  `ghostty-webgpu` `3c3e07edef23cdbbe141410432e89276cb6504b2`.
- Final Platform checkout after concurrent repository updates:
  `4b34a1e97e6c6dd953df715aa40778f98b6ccf1e`.
- Final `ghostty-webgpu` checkout after the proof files were concurrently committed:
  `a92108fd06d43b9e66e114ef4a863b669dd6624f`.
- Ghostty: `https://github.com/ghostty-org/ghostty.git` at
  `c8554f28e0efe2f5595f32020371c34b25ec628f`.
- Canonical `ghostty-upstream-tree-v1` SHA-256:
  `63d2b0c41531162a70b838369c0c225745e167495763ebbd0bc2fe546976a2bb` over 5,864 entries.
- Compiler: Zig `0.16.0` exactly. The official Linux x64 archive is 55,478,392 bytes with SHA-256
  `70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00`; its extracted executable
  has SHA-256 `2317bbb91798556d9d0f38aabdac23db83f0979b25f767259ae474546724087c`.
- Shared `SOURCE_DATE_EPOCH`: `1787590337`, the pinned Ghostty commit timestamp.
- Stop-recipe SHA-256: `b8d7325dd825696614c8481d3293b9c3750f29960ec0154d262d800a5f4d4c92`.
- Built-in theme archive:
  `https://deps.files.ghostty.org/ghostty-themes-release-20260810-152212-0173c3c.tgz`, 78,218 bytes,
  SHA-256 `ea9878471420ee5b12e7f2ff480099c954ea50e573a1bdf83f43e105c9be63f0`.
- Local supporting runner: Linux x86-64 with glibc 2.44; Bun 1.4.0 SHA-256
  `33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b`; Node 26.7.0 SHA-256
  `ad19784f7e90ba789a099eccba77ede8dc90a778c424f1c10a70fed3ff903fdc`; GNU strip 2.47 SHA-256
  `0a545ad873bc63f047e63106b9a0b069e40bd49339ab3b329c23184d5bf2df29`.
- Native matrix runner images: none. The macOS no-write failure is structural and stops the proof
  before a four-target workflow is authorized or useful.

The non-writing decision command was:

```text
bun scripts/config-resolver-proof/run.ts --upstream /tmp/plan-065.fOoEIf/ghostty --zig /tmp/plan-065.fOoEIf/zig-x86_64-linux-0.16.0/zig --zig-archive /tmp/plan-065.fOoEIf/zig-x86_64-linux-0.16.0.tar.xz --evidence <new-temporary-file>
```

It required the exact Zig version and archive, a clean detached upstream checkout, SHA-1 Git object
format, the exact upstream revision and canonical tree digest, the accepted optional-heavy build
graph, the proof's read-only file-loader composition, and the pinned macOS `create: true` call. It
emitted `macos-default-path-builder-can-create-directory`.

The successful native Linux x64 build command was:

```text
bun scripts/config-resolver-proof/build-helper.ts --upstream /tmp/plan-065.fOoEIf/ghostty --zig /tmp/plan-065.fOoEIf/zig-x86_64-linux-0.16.0/zig --zig-archive /tmp/plan-065.fOoEIf/zig-x86_64-linux-0.16.0.tar.xz --themes-archive /tmp/plan-065.fOoEIf/ghostty-themes.tgz --target linux-x64 --output /tmp/plan-065-repro-a --cache /tmp/plan-065.fOoEIf/zig-cache-musl --global-cache /tmp/plan-065.fOoEIf/zig-global-cache --evidence /tmp/plan-065-repro-a.build.json
```

The fixed internal build invocation was:

```text
zig build --prefix /tmp/ghostty-config-resolver-proof-build-v1/prefix --cache-dir /tmp/plan-065.fOoEIf/zig-cache-musl --global-cache-dir /tmp/plan-065.fOoEIf/zig-global-cache -Doptimize=ReleaseSafe -Dtarget=x86_64-linux-musl
```

The build environment contained only fixed `HOME`, `LANG`, `LC_ALL`, `PATH`, `SOURCE_DATE_EPOCH`,
`TMPDIR`, and `XDG_CACHE_HOME` entries. A second build from the same fixed source root produced the
same stripped artifact hash.

Gate 0 package hashes were unchanged at completion:

| Input | SHA-256 |
| --- | --- |
| `ghostty-vt.wasm` | `dfb171587bc11b6610fb95d3b583926d51287f5d6e528c45ff2aa05218608a97` |
| `bridge.wasm` | `47fae389c94f2545b2026d756256272b65f978d97feabae21b9171ad4b54b63f` |
| `scripts/build-wasm.ts` | `c3132eb6cf210aa841713972225a39e45658154199572df6a237d65206c85d99` |

## 3. Exact build, module, generated-source, and resource graph

The package's existing `src/build/GhosttyZig.zig` exposes only `vt` and `vt_c`. Config therefore uses
the application-side graph without modifying the package API:

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
  -> src/build/SharedDeps.zig
    -> uucode, locale/PTY C translations, help/unicode/framedata generators
    -> freetype, HarfBuzz, fontconfig, libpng, zlib, libxml2
    -> oniguruma, glslang, SPIRV-Cross
    -> OpenGL/glad, stb, libxev, vaxis, wuffs, z2d, zf, dcimgui
    -> embedded JetBrains Mono and Nerd Font files
```

The proof sets `app_runtime = .none`, `emit_lib_vt = false`, and disables sentry, SIMD, i18n, X11,
and Wayland through official build options. `SharedDeps.add` still retains the renderer/compiler
graph, as accepted for an optional helper. No Ghostty source is copied or patched: a temporary
overlay symlinks `dist`, `images`, `pkg`, `src`, `vendor`, and `build.zig.zon` from the clean checkout
and adds only the proof entry point and build file.

The local `x86_64-linux-musl` executable was 57,238,240 bytes unstripped. The deterministic stripped
artifact was 8,317,808 bytes with SHA-256
`b8b19ec944a676c88498304f66efa4f63066f4f958df4c1df0cc41a6c08dd97c`. `file` reported a static
x86-64 ELF, `ldd` reported `not a dynamic executable`, and `readelf -d` reported no dynamic section
or `NEEDED` entries. It requires no installed Ghostty, Zig, libc, or system GUI library at runtime.

The runtime bundle layout exercised by relocation was:

```text
<optional-host-package>/
  bin/ghostty-config-resolver-proof
  resources/themes/<602 pinned theme files>
```

The 602 extracted theme files total 285,946 bytes. The host sets `GHOSTTY_RESOURCES_DIR` to the
bundle-relative `resources` directory. The helper and resources worked after relocation away from
the checkout, compiler, and build cache.

## 4. Initialization, light/dark transition, ownership, and deinitialization

The demonstrated sequence is:

1. call `global.init(.tool)` and retain `global.deinit` for process teardown;
2. allocate `Config.default`;
3. enumerate legacy XDG then current XDG through upstream path builders;
4. on macOS, enumerate legacy Application Support then upstream `preferredAppSupportPath`, skipping
   the second load when it equals legacy;
5. pass each candidate only to `Config.loadOptionalFile`;
6. return `not-configured` if none loaded, without calling `Config.loadDefaultFiles`, `Config.load`,
   or `writeConfigTemplate`;
7. call `loadRecursiveFiles` and `finalize` after at least one successful read;
8. retain the finalized Config as the light profile;
9. call `changeConditionalState(.{ .theme = .dark })`; use the returned owned Config, or call
   `Config.clone` when the transition returns `null`; and
10. deinitialize dark, light, then global state.

The conditional and clone ownership paths passed under native execution and ordinary allocator
teardown. The blocker occurs in step 4: `legacyDefaultAppSupportPath` and
`preferredAppSupportPath` both reach `appSupportDir`, whose Foundation request passes `true` for the
`create` parameter before any `loadOptionalFile` call.

## 5. Semantic fixture results

The complete fixture suite passed natively on Linux x64 under both Bun and Node harness execution:

- empty config returned `not-configured`;
- legacy/current XDG location and current-over-legacy precedence matched the pin;
- nested, repeated, and cyclic includes produced the expected order, reset, last-value behavior,
  and a diagnostic count of three without exposing diagnostic text;
- built-in and file themes, named colors, explicit RGB values, and the original palette mask flowed
  through Ghostty;
- explicit palette indices survived generation and the full 256-entry RGB-byte stream hashed to
  `3924d9bb39f6716d63524fb520f2100c5e93c52708967ecf5bc7e648cab0fa65`;
- the mandatory `Afterglow` / `3024 Day` conditional produced distinct correct profiles;
- a `null` conditional transition produced an independently owned clone equal to light;
- cursor and selection values preserved `cell-foreground` and `cell-background` tags; and
- opacity, opacity-cells, numeric/boolean blur, both macOS glass enums, and `display-p3` were emitted
  as bounded typed values.

The mandatory conditional values were:

| Profile | Background | Foreground | Cursor text | Palette assertions |
| --- | --- | --- | --- | --- |
| light | `#f7f7f7` | `#4a4543` | `#f7f7f7` | 0 `#090300`, 15 `#f7f7f7` |
| dark | `#212121` | `#d0d0d0` | `#151515` | 0 `#151515`, 6 `#7dd6cf` |

Both profiles contained 256 colors and retained opacity `0.9` and radius `20`.

The frozen Display-P3 conversion uses IEEE-754 binary64 in this order: decode with thresholds
`0.04045` and `0.0031308`, multiply by these full-precision matrices, clamp linear sRGB to `[0, 1]`,
encode, multiply by 255, and round half up.

```text
Display-P3 -> XYZ D65
[ 0.4865709486482162,   0.26566769316909306,  0.1982172852343625  ]
[ 0.2289745640697488,   0.6917385218365064,   0.079286914093745   ]
[ 0,                    0.04511338185890264,  1.043944368900976   ]

XYZ D65 -> linear sRGB
[ 3.2409699419045226,  -1.537383177570094,   -0.4986107602930034  ]
[-0.9692436362808796,   1.8759675015077202,   0.04155505740717559 ]
[ 0.05563007969699366, -0.20397695888897652,  1.0569715142428786  ]
```

Black, white, all primaries, the mixed vector P3 `(111,85,28)` to sRGB `(116,84,8)`, gamut
clipping, both transfer branches, and values immediately around half-up byte boundaries passed.

## 6. No-write and privacy results

Linux passed the complete no-write harness. The verifier snapshots the isolated home and config
trees recursively before and after missing-config execution. It also pauses the helper after
candidate discovery, deletes or renames each XDG candidate before open, and proves the result is
`not-configured` with unchanged roots. The helper contains no call to Ghostty's template-writing
aggregate.

macOS fails before those reads. At the exact pin:

```text
src/config/file_load.zig:63-70
  defaultAppSupportPath / legacyDefaultAppSupportPath
    -> internal_os.macos.appSupportDir

src/os/macos.zig:124-133
  URLForDirectory:inDomain:appropriateForURL:create:error:
    -> create argument: true
```

Foundation's requested behavior is to create the requested directory when it does not exist. The
mandatory fixture begins with an empty isolated home, so path discovery itself is not read-only.
The verifier deliberately does not pre-create `Library/Application Support`; doing so would make
the observation impossible rather than make the implementation safe.

All executed output was one bounded JSON value of at most 128 KiB and stderr was empty. Recursive
strict validation rejected unknown keys and out-of-range values. The harness scanned stdout and
stderr for the fixture path, secret, theme, and diagnostic sentinels. Ghostty logs used a no-op sink,
and proof failures emit fixed reason enums rather than native messages or config data. The Linux
privacy suite passed under Bun and Node.

## 7. Four-target evidence

The exact required matrix remains intact. A global no-write failure makes every native row
incomplete; the local Linux result is supporting evidence only and is not substituted for the
required four-runner matrix.

| Target | Runner | Artifact hash / bytes | Dependencies | Native execution | Semantics | No-write | Compatibility | Relocation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `darwin-arm64` | not run after global STOP | `null` / 0 | incomplete | incomplete | incomplete | incomplete | incomplete | incomplete |
| `darwin-x64` | not run after global STOP | `null` / 0 | incomplete | incomplete | incomplete | incomplete | incomplete | incomplete |
| `linux-arm64` | not run after global STOP | `null` / 0 | incomplete | incomplete | incomplete | incomplete | incomplete | incomplete |
| `linux-x64` | local supporting run only | `null` / 0 in matrix | incomplete | incomplete | incomplete | incomplete | incomplete | incomplete |

No workflow was added or run. Committing, pushing, or dispatching one was not authorized, and native
matrix work cannot turn a structural macOS write into `PASS`.

## 8. Proposed package layout, size ceiling, and runtime selection

The measured optional layout is technically bounded: an approximately 8.3 MB stripped host helper
plus 285,946 bytes of theme resources per platform package. If a future proof passes, the host must
dynamically resolve and spawn only the matching optional package after the registered appearance
feature is enabled. Missing optional bytes must preserve the existing appearance without a config
read, subprocess, runtime download, or startup failure.

No package ceiling is proposed or accepted because the no-write contract fails. The strict JSON's
positive one-byte values are early-FAIL sentinels required by the fixed evidence shape; they are not
shipping recommendations.

## 9. Known fidelity degradations and fallback recommendations

The visual projection itself has no observed Linux fidelity gap for the required fields. Dynamic
cell-relative colors remain tagged rather than being guessed. Plan 066 would still need to choose a
deterministic browser fallback for those tags and apply the frozen Display-P3 conversion.

The narrow fix is upstream: add a read-only Config candidate API whose macOS directory lookup uses
`create: false`, or expose a Config resolver that accepts already discovered candidates while
preserving official precedence. If a future Ghostty fork is ever considered, first prefer
contributing that read-only path boundary and a Config-only initializer/build target upstream. The
optional-heavy-helper allowance does not authorize a fork and is not the preferred long-term graph.

Until such an upstream boundary exists, retaining the current Platform appearance is the only
authorized fallback. An installed Ghostty command, TypeScript parser, copied macOS path algorithm,
runtime download, or startup-time probe is not an acceptable substitute.

## 10. Blockers and residual risks

- Blocking fact: both official macOS Application Support candidate builders call a Foundation API
  with `create: true`; candidate discovery can write beneath an empty isolated home.
- Avoiding that write requires changing upstream, copying/altering path policy, or authorizing a
  third divergence. None is in scope.
- The GUI/shader dependencies remain heavy but bounded under the accepted optional-helper
  divergence. A future upstream Config-only target is still preferred before any fork.
- The four native target, macOS dependency, and macOS compatibility rows were not run after the
  decisive global no-write failure. They remain incomplete rather than inferred.
- The requested never-nester skill file was absent from this Linux host and no alternate copy was
  discoverable. The equivalent guard-clause, shallow-nesting, loop-inversion, and no-`else` rules in
  both repository instructions were applied.
- Existing user work outside the proof paths was preserved. No commit, push, publish, package API
  edit, Platform source edit, or Plan 066–067 execution was performed by this proof run.

Decision: FAIL
