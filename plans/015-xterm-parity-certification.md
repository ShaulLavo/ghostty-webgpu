# Plan 015: Certify versioned xterm parity and close the compatibility program

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. This plan may mark the program complete only after every
> automated and physical gate has evidence and the parity ledger has zero gaps.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- . ':!references/xterm.js'`
> Confirm Plans 006–014 are DONE, the reference/source/package identities pass, and the generated
> ledger contains no row owned by an earlier DONE plan that is still missing/partial/blocked.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plans 006–014 DONE
- **Category**: certification / release readiness / documentation
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

Individual green feature tests do not justify “drop-in replacement” or “full parity.” The claim must
be version-bounded, package-installable, cross-browser, parser/input compatible, performant,
accessible, security-reviewed, and backed by a zero-gap ledger. This final plan tries to falsify the
claim before publishing it.

## Claim boundary

The initial certification target is xterm core/headless release `6.0.0`, source tag commit
`f447274f430fd22513f6adbf9862d19524471c04`, with addon versions recorded by Plan 007 and forward
reference source pinned at `08ad9a4de9252f387cc5fbf68aa3d98e0ba8a0b7`.

The allowed final wording is:

> `@ghostty-webgpu/*` is API- and feature-compatible with the recorded xterm.js 6.0.0 package set and
> can replace `@xterm/*` imports through package-manager aliases on the certified environments.

Do not claim pixel identity, private-internal compatibility, ownership of the `@xterm` scope, or
bug-for-bug equivalence. Any intentional VT behavior difference must be standards-backed, listed,
operator-approved, and must not break the public feature/API claim.

If a newer xterm release exists when this plan executes, report it. The operator chooses either to
certify the explicitly recorded 6.0.0 baseline or run the Plan 007 atomic upgrade flow first. Do not
quietly move the target during certification.

## Commands you will need

| Purpose                | Command                                            | Expected on success                                 |
| ---------------------- | -------------------------------------------------- | --------------------------------------------------- |
| Zero-gap ledger        | `bun run xterm:parity -- --require-complete`       | no missing/partial/blocked rows                     |
| Complete differential  | `bun run test:xterm-conformance`                   | core/headless/addon behavior matches                |
| Browser matrix         | `bun run test:xterm-browsers`                      | certified Chromium/Firefox/WebKit environments pass |
| Alias/tarball fixtures | `bun run test:xterm-aliases && bun run pack:check` | installed artifacts work unchanged                  |
| VT corpus              | `bun run test:xterm-vt`                            | shared standard/reference corpus passes             |
| Security checks        | `bun run test:xterm-security`                      | limits, links, clipboard, parser, images pass       |
| Hardware qualification | `bun run bench:renderer`                           | recorded CPU/GPU/memory/idle thresholds pass        |
| Repository full gate   | `bun run verify`                                   | all checks pass                                     |

## Scope

**In scope**:

- conformance/differential/VT/fuzz test harnesses and fixtures
- current stable browser and supported runtime matrix
- package alias/tarball install fixtures
- performance, memory, idle, device-loss, and long-run qualification
- security review of untrusted terminal input and external boundaries
- physical keyboard/IME/clipboard/accessibility/visual test execution by an operator
- `docs/xterm-parity.json` and generated Markdown
- versioned compatibility/security/browser/performance documentation
- README claims and migration guide
- existing Phase 3 acceptance evidence
- `plans/README.md`

**Out of scope**:

- Publishing packages, tags, releases, announcements, or registry changes without explicit operator
  authorization.
- Moving the certified xterm version implicitly.
- Compatibility with xterm private `_core` services or undocumented DOM internals.
- Hiding gaps as `not-applicable` because they are difficult.
- Self-certifying physical operator steps.

## Git workflow

- Work in the current worktree; do not branch, commit, push, publish, tag, or open a PR unless
  requested.
- Certification evidence must identify exact source commit, package versions, browser/runtime
  versions, OS/hardware, WASM hashes, and package tarball hashes.

## Steps

### Step 1: Freeze inputs and audit the ledger

Record every core/headless/addon version, submodule SHA, Ghostty revision, bridge ABI, dependency
lock, browser/runtime version, and artifact hash. Regenerate the inventory and manually audit every
`not-applicable` row against the upstream public declarations.

Reject completion if any row is missing, partial, blocked, lacks evidence, points at a missing test,
or relies only on a type assertion for behavioral compatibility.

### Step 2: Run the complete differential suite

Execute constructor/options/events/methods, buffer/cell/modes/parser/Unicode, input/selection/mouse/
DOM/accessibility, every addon, and headless scenarios against the exact released reference and
target artifacts. Run target tests from packed alias-installed dependencies, not source workspaces.

Vary write chunking, operation order, lifecycle races, normal/alternate buffers, reflow, scrollback,
DPR, fonts, shadow DOM, and disposal. Any unexplained difference falsifies the claim until resolved
or explicitly approved as a standards-backed intentional difference.

### Step 3: Run VT and fuzz conformance

Use licensed/public VT corpora plus generated sequences for CSI/DCS/OSC/APC, modes, colors, Unicode,
selection, clipboard, progress, links, and image protocols. Differential fuzz chunk boundaries and
handler registration/disposal while bounding input size/time.

Classify failures as target defect, reference defect, documented standards difference, or harness
defect with raw evidence. Two special-case patches invalidate a theory; return to the raw sequence
and re-derive before adding more exceptions.

### Step 4: Run security and resource-limit review

Test hostile OSC 8 URLs, OSC 52 payloads, parser handler rejection/reentry, huge parameters, malformed
UTF-8, catastrophic regex patterns, SIXEL/IIP/Kitty decompression/size bombs, WebSocket races, HTML
serialization injection, font/image allocation, addon disposal, and cross-document/shadow DOM input.

Confirm default-deny clipboard/link policies, no implicit network navigation/fetch, bounded caches,
no dangling listeners/timers, and safe WASM pointer/length validation.

### Step 5: Run cross-browser, runtime, and package installation matrix

Install packed packages through aliases into clean fixtures. Test current supported Node/Bun for
headless and stable Chromium/Edge-equivalent, Firefox, and WebKit/Safari-equivalent browsers for DOM.
Exercise Vite, Rollup, webpack, esbuild, workers where supported, CSS imports, code splitting, and
WASM asset hosting.

Record unsupported environments explicitly; they must not be environments promised by the reference
baseline.

### Step 6: Run performance and soak qualification

Run three comparable headed hardware samples for idle, blink, burst, sustained scroll, glyph churn,
ligatures, search, serialization, images, resize/DPR, atlas churn, and device loss. Measure CPU, GPU
submission/draws, uploads, peak JS/WASM/GPU/image memory, input latency, frame latency, and idle work.

Add a bounded soak with repeated create/open/write/resize/addon activate-dispose/device recovery and
verify resource counts return to baseline. Do not relax thresholds during this plan; a failed ceiling
returns to the owning implementation plan.

### Step 7: Perform physical operator gates

An operator records results on certified hardware for:

- held printable/navigation/function key repeat and release under Kitty keyboard mode;
- macOS, Windows, and Linux shortcut conventions including AltGraph and platform IMEs;
- Japanese/Chinese/Korean composition, emoji/dead keys, clipboard permission flows;
- mouse reporting versus selection, touch/trackpad, high-DPI and fractional DPR resize;
- VoiceOver/Safari and NVDA/Firefox or Edge screen-reader workflows;
- ligature/custom glyph/color emoji and SIXEL/IIP/Kitty image visual fidelity;
- device loss/recovery and long scrollback interaction.

Automated agents may prepare the checklist and capture diagnostics but may not mark these items PASS.

### Step 8: Publish documentation claims only after evidence

Update README and compatibility docs with the exact certified package set, alias installation,
supported environments, intentional differences, security defaults, performance evidence, and
upgrade policy. Remove earlier “not a drop-in” wording only if the zero-gap and physical gates pass;
otherwise retain it and state the precise remaining blockers.

### Step 9: Close the program without publishing

Run all commands once more from a clean install of packed artifacts. Mark Plan 015 and the program
DONE only when results are reproducible. Report that artifacts are release-ready, but do not publish,
tag, push, or announce without a new explicit operator request.

## Test plan

- Zero-gap schema/inventory gate covers all public release surfaces.
- Differential tests use exact packed reference/target packages.
- VT/fuzz/security corpora stress parser and resource boundaries.
- Browser/runtime/bundler matrix proves installability and environment support.
- Hardware/soak evidence proves performance and cleanup.
- Physical checklist covers inputs and assistive technologies automation cannot certify.

## Done criteria

- [ ] Exact source/package/browser/runtime/artifact identities are frozen and recorded.
- [ ] Ledger contains zero missing, partial, or blocked rows and no unjustified `not-applicable` row.
- [ ] Complete differential, VT, fuzz, security, browser, alias, tarball, and full repository gates
      pass.
- [ ] Three-run hardware qualification and bounded soak pass without threshold relaxation.
- [ ] Every physical operator item is recorded PASS on named environments.
- [ ] README claim is version-bounded and says “through package aliasing.”
- [ ] Intentional standards-backed differences, if any, are operator-approved and documented.
- [ ] No package, tag, commit, push, or announcement occurred without authorization.
- [ ] Plan 015 and the compatibility program are DONE.

## STOP conditions

Stop and report if:

- Any ledger gap, missing evidence, unjustified exclusion, or stale reference identity remains.
- A newer xterm release exists and the operator has not chosen whether to retain or update the target.
- Differential/VT behavior differs without a standards-backed explanation and explicit approval.
- A security/resource test escapes configured bounds or an addon leaks after disposal.
- Any certified browser/runtime/bundler or packed alias install fails.
- Performance fails after three comparable runs or soak resources do not return to baseline.
- Any physical gate is pending, failed, or was not performed by an operator.
- Final wording would imply ownership of `@xterm`, zero-config replacement, pixel identity, or private
  internal compatibility.

## Maintenance notes

- Certification is versioned evidence, not a permanent adjective. New upstream releases reopen the
  ledger.
- Run conformance from packed aliases; source workspaces can conceal distribution failures.
- Keep physical and automated evidence separate and truthful.
