# Ghostty config resolver feasibility

## 1. Summary

Decision: **PASS**.

The two operator-accepted divergences are viable. The proof can enumerate fixed default candidates
instead of calling Ghostty's template-writing aggregate, and the resulting 8.3 MB stripped helper
can be treated as a platform-specific optional host dependency. The retained GUI/shader graph is
therefore measured packaging weight, not this decision's blocker.

The next audit found that both pinned Application Support candidate builders reach
`src/os/macos.zig::commonDir`, which asks Foundation to create the directory. The operator clarified
that this is not a terminal gate: it refines the accepted fixed-candidate divergence. Proof source
`e9c198e073067d5415ac4224176db1eb076f5dbf` skips both create-capable builders and derives the
fixed legacy/current paths lexically from `HOME` plus the pinned Application Support suffixes. The
first filesystem operation remains Ghostty's read-only optional-file load.

Workflow run `33212162580`, attempt 1, observed the complete native matrix at that exact proof HEAD.
All four rows record literal pass results for native execution, semantics, no-write behavior,
dependencies, compatibility, relocation, privacy, and Display-P3 vectors. On 2026-08-29, the
operator explicitly accepted the exact per-target and total package ceilings in section 8. The
feasibility proof is complete. Plan 066 is eligible only for a separate root go/no-go scheduling
decision; this result does not authorize packaging, and Plan 067 remains blocked on Plan 066's
reviewed artifact.

## 2. Exact inputs and proof commands

- Authorized reconciliation bases: Platform `4b25f1ab28eab2da499ac0cf0fcc633af1ea6640` and
  `ghostty-webgpu` `3c3e07edef23cdbbe141410432e89276cb6504b2`.
- Final Platform checkout after concurrent repository updates:
  `4b34a1e97e6c6dd953df715aa40778f98b6ccf1e`.
- Native evidence proof-source checkout:
  `e9c198e073067d5415ac4224176db1eb076f5dbf`.
- Ghostty: `https://github.com/ghostty-org/ghostty.git` at
  `c8554f28e0efe2f5595f32020371c34b25ec628f`.
- Canonical `ghostty-upstream-tree-v1` SHA-256:
  `63d2b0c41531162a70b838369c0c225745e167495763ebbd0bc2fe546976a2bb` over 5,864 entries.
- Compiler: Zig `0.16.0` exactly. The official Linux x64 archive is 55,478,392 bytes with SHA-256
  `70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00`; its extracted executable
  has SHA-256 `2317bbb91798556d9d0f38aabdac23db83f0979b25f767259ae474546724087c`.
- Shared `SOURCE_DATE_EPOCH`: `1787590337`, the pinned Ghostty commit timestamp.
- Final schema-v2 proof-recipe SHA-256:
  `40083f27ad5f925808cc48e0fdd428b4ab0515eb38dedb42b0ca2065a16e44f0`. It preserves the literal
  raw link invocation in native evidence while binding a strict projection of only Zig's
  runner-local `/final-cache/o/<32-lowercase-hex>` components.
- Built-in theme archive:
  `https://deps.files.ghostty.org/ghostty-themes-release-20260810-152212-0173c3c.tgz`, 78,218 bytes,
  SHA-256 `ea9878471420ee5b12e7f2ff480099c954ea50e573a1bdf83f43e105c9be63f0`.
- Local supporting runner: Linux x86-64 with glibc 2.44; Bun 1.4.0 SHA-256
  `33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b`; Node 26.7.0 SHA-256
  `ad19784f7e90ba789a099eccba77ede8dc90a778c424f1c10a70fed3ff903fdc`; GNU strip 2.47 SHA-256
  `0a545ad873bc63f047e63106b9a0b069e40bd49339ab3b329c23184d5bf2df29`.
- Native evidence workflow: run `33212162580`, attempt `1`, on `macos15` arm64 image
  `20260727.0256.1`, `macos15` x64 image `20260824.0482.1`, `ubuntu24-arm64` image
  `20260823.101.1`, and `ubuntu24` x64 image `20260823.283.1`.

The corrected non-writing boundary command is:

```text
bun scripts/config-resolver-proof/run.ts --upstream /tmp/plan-065.fOoEIf/ghostty --zig /tmp/plan-065.fOoEIf/zig-x86_64-linux-0.16.0/zig --zig-archive /tmp/plan-065.fOoEIf/zig-x86_64-linux-0.16.0.tar.xz --evidence <new-temporary-file>
```

It requires the exact Zig version and archive, a clean detached upstream checkout, SHA-1 Git object
format, the exact upstream revision and canonical tree digest, the accepted optional-heavy build
graph, the proof's read-only file-loader composition, and the pinned macOS `create: true` call. It
also rejects either create-capable builder in proof source and freezes the lexical candidates. The
local command remains supporting evidence; the required native observations are the four artifacts
from workflow run `33212162580`.

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

Gate 0 package hashes were unchanged at native evidence collection:

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

The native evidence artifacts are two Mach-O 64-bit executables with system-only dynamic
dependencies and two statically linked, stripped ELF executables with no dependency entries. The
Linux x64 artifact remained 8,317,808 bytes with SHA-256
`b8b19ec944a676c88498304f66efa4f63066f4f958df4c1df0cc41a6c08dd97c`. The Linux packages require
no installed Ghostty, Zig, libc, or system GUI library at runtime; the macOS packages bind only the
recorded `/System/Library` frameworks and `/usr/lib` libraries.

The runtime bundle layout exercised by relocation was:

```text
<optional-host-package>/
  bin/ghostty-config-resolver-proof
  resources/themes/<602 pinned theme files>
```

The 602 extracted theme files total 285,946 bytes; the measured resource tree contains 604 entries
including its directories and hashes to
`82fedc97c3cbe87e3b56dff51a24592534172f2e6d04baf54c0e83969f8dfc18`. The host sets
`GHOSTTY_RESOURCES_DIR` to the bundle-relative `resources` directory. Every native row passed
relocation away from the checkout, compiler, and build cache.

## 4. Initialization, light/dark transition, ownership, and deinitialization

The demonstrated sequence is:

1. call `global.init(.tool)` and retain `global.deinit` for process teardown;
2. allocate `Config.default`;
3. enumerate legacy XDG then current XDG through upstream path builders;
4. on macOS, derive legacy then current Application Support candidates lexically from `HOME`,
   `Library/Application Support/com.mitchellh.ghostty`, and the pinned filenames without invoking
   either create-capable upstream path builder;
5. pass each candidate only to `Config.loadOptionalFile`;
6. return `not-configured` if none loaded, without calling `Config.loadDefaultFiles`, `Config.load`,
   or `writeConfigTemplate`;
7. call `loadRecursiveFiles` and `finalize` after at least one successful read;
8. retain the finalized Config as the light profile;
9. call `changeConditionalState(.{ .theme = .dark })`; use the returned owned Config, or call
   `Config.clone` when the transition returns `null`; and
10. deinitialize dark, light, then global state.

The sequence, conditional transition, clone ownership path, and ordinary allocator teardown passed
on all four native targets. Both macOS rows executed the corrected lexical step 4 and passed the
absent, delete-race, and rename-race no-write checks.

## 5. Semantic fixture results

All four native rows passed the semantic fixture suite. The compatibility probes also passed the
same bounded vectors under Bun and Node on each target:

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
clipping, both transfer branches, and values immediately around half-up byte boundaries passed on
all four native targets.

## 6. No-write and privacy results

All four native targets passed the complete no-write harness. The verifier snapshots the isolated
home and config trees recursively before and after missing-config execution. It also pauses the
helper after candidate discovery, deletes or renames each candidate before open, and proves the
result is `not-configured` with unchanged roots. Each Darwin row covered one absent case, four
delete races, four rename races, and 22 immutable snapshots; each Linux row covered one absent
case, two delete races, two rename races, and 15 immutable snapshots. The helper contains no call
to Ghostty's template-writing aggregate.

The audit found the macOS builders that must be skipped. At the exact pin:

```text
src/config/file_load.zig:63-70
  defaultAppSupportPath / legacyDefaultAppSupportPath
    -> internal_os.macos.appSupportDir

src/os/macos.zig:124-133
  URLForDirectory:inDomain:appropriateForURL:create:error:
    -> create argument: true
```

Foundation's requested behavior is to create the requested directory when it does not exist. The
corrected helper therefore calls neither builder. It joins the fixed suffix beneath the explicit
isolated `HOME` without opening or creating anything, then passes the two filenames to
`loadOptionalFile`. The native macOS harness began with no `Library/Application Support` directory;
both macOS rows observed that absent-root discovery and the delete/rename races left the isolated
roots unchanged.

All executed output was one bounded JSON value of at most 128 KiB and stderr was empty. Recursive
strict validation rejected unknown keys and out-of-range values. The harness scanned stdout and
stderr for the fixture path, secret, theme, and diagnostic sentinels. Ghostty logs used a no-op sink,
and proof failures emit fixed reason enums rather than native messages or config data. The Linux
and macOS privacy checks all passed, as did the Bun and Node compatibility probes.

## 7. Four-target evidence

Workflow run `33212162580`, attempt `1`, produced all four native rows from common proof HEAD
`e9c198e073067d5415ac4224176db1eb076f5dbf`, upstream tree
`63d2b0c41531162a70b838369c0c225745e167495763ebbd0bc2fe546976a2bb`, recipe
`40083f27ad5f925808cc48e0fdd428b4ab0515eb38dedb42b0ca2065a16e44f0`, and
`SOURCE_DATE_EPOCH=1787590337`.

| Target | Runner | Artifact hash / bytes | Dependencies | Native execution | Semantics | No-write | Compatibility | Relocation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `darwin-arm64` | `macos15` / `20260727.0256.1` | `0195d2aba4845e59057350d3be696d64029cdf6e0a08315f9a863a270db68cdb` / 1422112 | pass | pass | pass | pass | pass | pass |
| `darwin-x64` | `macos15` / `20260824.0482.1` | `d13180760d702dfc11a6f888244e1a85e61d587d483823046c24e3cba621a6e2` / 1443864 | pass | pass | pass | pass | pass | pass |
| `linux-arm64` | `ubuntu24-arm64` / `20260823.101.1` | `98181e3ba5f70ccf4b1ddf68f285a85cd1972c4a914b3b2535d75746d6ed9460` / 7737280 | pass | pass | pass | pass | pass | pass |
| `linux-x64` | `ubuntu24` / `20260823.283.1` | `b8b19ec944a676c88498304f66efa4f63066f4f958df4c1df0cc41a6c08dd97c` / 8317808 | pass | pass | pass | pass | pass | pass |

The exact row toolchain identities are:

| Target | Zig / linker SHA-256 | Strip SHA-256 | SDK or sysroot SHA-256 |
| --- | --- | --- | --- |
| `darwin-arm64` | `e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec` | `7f30f076d0e9c38f772a76449fca9da8cf97f6a3d43b94c90a00e4f9ce7ad39e` | `c9c1a6425d73dd1169710c5654d0698e16254263a34f659b6952bccf54b91d8c` |
| `darwin-x64` | `5597fba0eb9d8f1f5331e3e5822e7e96e4a12eeb6f4939781bd8e2c13b15e8b5` | `7f30f076d0e9c38f772a76449fca9da8cf97f6a3d43b94c90a00e4f9ce7ad39e` | `c9c1a6425d73dd1169710c5654d0698e16254263a34f659b6952bccf54b91d8c` |
| `linux-arm64` | `6e2989a7efbd4e81acbacb6c6378e34340d8e88bb023b10c4a941021be55cdcb` | `3a69e3786ea2884baf4d9811e509ba6d16be03d5d6f541103b8de317a2465fca` | `2a0c38102b95ac87975f84f80710c67984841d3059031ff2cb5170b14ac8b3fd` |
| `linux-x64` | `2317bbb91798556d9d0f38aabdac23db83f0979b25f767259ae474546724087c` | `0d980587ada7ab12193f39271f060d5663aa2f289b0e80d2a0274ce7306e4e42` | `2a0c38102b95ac87975f84f80710c67984841d3059031ff2cb5170b14ac8b3fd` |

Each row also records `officialReadOnlyGraph`, absent/delete/rename no-write checks, privacy, and
Display-P3 vectors as literal `pass`. Together with the exact operator-accepted ceilings below, the
observed matrix establishes the final decision.

## 8. Proposed package layout, size ceiling, and runtime selection

The measured optional layout is technically bounded. The accepted ceilings round each observed
bundle up to the next whole MiB.

| Target | Artifact bytes | Resource bytes | Bundle bytes | Package ceiling bytes |
| --- | ---: | ---: | ---: | ---: |
| `darwin-arm64` | 1422112 | 285946 | 1708058 | 2097152 |
| `darwin-x64` | 1443864 | 285946 | 1729810 | 2097152 |
| `linux-arm64` | 7737280 | 285946 | 8023226 | 8388608 |
| `linux-x64` | 8317808 | 285946 | 8603754 | 9437184 |

Total measured bundle bytes: 20064848; total package ceiling bytes: 22020096.

Operator acceptance: **accepted on 2026-08-29** for the exact per-target ceilings `2097152`,
`2097152`, `8388608`, and `9437184` bytes and total ceiling `22020096` bytes. A future host must
dynamically resolve and spawn only the matching optional package after the registered appearance
feature is enabled. Missing optional bytes must preserve the existing appearance without a config
read, subprocess, runtime download, or startup failure.

## 9. Known fidelity degradations and fallback recommendations

The visual projection itself has no observed fidelity gap for the required fields across the four
native evidence rows. Dynamic cell-relative colors remain tagged rather than being guessed. Plan
066 would still need to choose a deterministic browser fallback for those tags and apply the frozen
Display-P3 conversion.

The preferred upstream improvement remains a read-only Config candidate API whose macOS directory
lookup uses `create: false`, or a resolver that accepts already discovered candidates while
preserving official precedence. The accepted interim boundary derives only the frozen default
paths; it does not copy parsing, include, theme, conditional, diagnostic, color, or palette logic.
An installed Ghostty command, TypeScript parser, runtime download, or startup-time probe remains
outside the proof.

## 10. Blockers and residual risks

- Both official macOS Application Support candidate builders call a Foundation API with
  `create: true`; corrected proof source skips them under the accepted fixed-candidate divergence.
- The GUI/shader dependencies remain heavy but bounded under the accepted optional-helper
  divergence. A future upstream Config-only target is still preferred before any fork.
- No feasibility-proof blocker remains. Plan 066 still requires a separate root go/no-go scheduling
  decision, and Plan 067 remains blocked on Plan 066's reviewed artifact.
- The requested never-nester skill file was absent from this Linux host and no alternate copy was
  discoverable. The equivalent guard-clause, shallow-nesting, loop-inversion, and no-`else` rules in
  both repository instructions were applied.
- Existing user work outside the proof evidence was preserved. Closeout does not edit package APIs,
  Platform source, or execute Plans 066–067.

Decision: PASS
