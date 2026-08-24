# Plan 012: Match xterm search, serialize, and Unicode addons

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in “STOP conditions”
> occurs, stop and report; do not improvise. When done, update the parity ledger and this plan's
> status row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat a7e7372..HEAD -- src/core src/term src/xterm src/render package.json docs plans`
> Confirm Plans 009–011 are DONE, especially native buffer/parser/Unicode/decorations support. Test
> official released addons first and record any private-service dependency before implementing an
> adapter.

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plans 009 and 011 DONE
- **Category**: addons / buffer data / Unicode
- **Planned at**: commit `a7e7372`, 2026-08-24

## Why this matters

Search and serialization exercise the entire buffer, styles, selections, modes, alternate screen,
markers, and decorations. The Unicode addons prove that public width providers alter the real parser
rather than facade metadata. Together they are the strongest validation of Plan 009's native
extension surfaces.

## Target contract

Match the pinned public types and released behavior for:

- `SearchAddon`, `findNext`, `findPrevious`, incremental/regex/whole-word/case options, highlight
  limits, decorations/overview ruler, clear methods, and before/after/results events;
- `SerializeAddon.serialize` with ranges/markers/scrollback/modes/alternate-buffer options;
- `SerializeAddon.serializeAsHTML` with range, selection-only, global background, styles, and
  escaping;
- `Unicode11Addon` registration/disposal;
- `UnicodeGraphemesAddon` registration/disposal and grapheme/emoji/ZWJ/variation behavior.

As in Plan 011, certify the official released addon unchanged when it works exclusively through
public APIs. Otherwise implement a public-contract adapter under `src/xterm/addons/`. Never add
xterm private `_core` services to production merely to run official addon code.

## Commands you will need

| Purpose               | Command                                                               | Expected on success                            |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| Data addon unit tests | `bun run test:unit -- src/xterm/tests/data-addons.test.ts`            | search/serialize/Unicode pure cases pass       |
| Data addon browser    | `bun run test:browser -- src/xterm/tests/data-addons.browser.test.ts` | selection/decorations/HTML match reference     |
| Differential corpus   | `bun run test:xterm-addons -- data`                                   | released reference and target outputs match    |
| Renderer benchmark    | `bun run bench:renderer`                                              | search decorations do not break qualified path |
| Parity/full gates     | `bun run xterm:parity && bun run verify`                              | evidence current and repository green          |

## Scope

**In scope**:

- `src/xterm/addons/search.ts`
- `src/xterm/addons/serialize.ts`
- `src/xterm/addons/unicode11.ts`
- `src/xterm/addons/unicode-graphemes.ts`
- only create adapters proven necessary
- native buffer/parser/Unicode fixes needed to satisfy already-approved Plan 009 contracts
- decoration/overview integration used by search
- `src/xterm/tests/data-addons.test.ts`
- `src/xterm/tests/data-addons.browser.test.ts`
- official addon dev dependencies pinned to manifest versions
- fixture corpus for styles, modes, buffers, ranges, and Unicode
- package/lock, README, parity docs, and `plans/README.md`

**Out of scope**:

- Image, ligature, web-font, or WebGL addons.
- Search indexes that duplicate all scrollback without a measured need.
- Serializing Ghostty-private state xterm cannot represent.
- Changing Ghostty width rules outside the active registered Unicode provider.
- Packaging/publishing addon names; Plan 014 owns artifacts.

## Git workflow

- Work in the current worktree; do not branch, commit, push, or open a PR unless requested.
- Keep golden fixtures small, reviewable, and generated only from stable public outputs.
- Retain notices for any adapted upstream algorithm/source.

## Steps

### Step 1: Prove official addon interoperability

Run each official released addon against the facade. Record whether it uses public buffer/parser/
unicode/decoration APIs or private services. Reuse it unchanged only if all target scenarios pass.
Otherwise select a project-native adapter and update the packaging owner row.

### Step 2: Implement search semantics over live buffers

Search active buffer plus scrollback through bounded line reads. Match forward/backward wrap,
incremental anchoring, regex validation, whole-word boundaries, case folding, wrapped lines, wide and
combining characters, zero-length matches, selection interaction, and return values.

When decorations are enabled, cap at `highlightLimit`, track active result/index/count, place
overview markers, and emit events in exact order. Cache only measured reusable normalization; key it
by buffer revision and invalidate incrementally.

### Step 3: Implement VT serialization

Generate restorable VT for requested marker/numeric ranges and scrollback, including cursor
placement, colors, styles, wrapping, normal/alternate screens, and modes. Validate by writing output
into a fresh same-sized terminal and comparing public buffer/mode/cursor state to the source.

Range validation, disposed markers, excluded modes, alternate-buffer exclusion, and empty terminal
behavior must match reference output exactly where public behavior is stable.

### Step 4: Implement safe HTML serialization

Serialize selection/range/full active buffer with correct text escaping, style spans, palette/RGB
colors, underline variants/colors, inverse/invisible/dim/bold/italic/strike/overline, whitespace,
line breaks, and optional global background. Do not emit unsanitized terminal text as markup or URL
attributes.

Browser differential tests compare normalized DOM trees and computed meaning, not irrelevant
attribute order.

### Step 5: Integrate Unicode 11 and grapheme providers

Register exact version ids and width/property behavior through Plan 009's native Unicode boundary.
Cover combining marks, East Asian width, ambiguous characters, emoji presentation, variation
selectors, skin tones, flags, keycaps, ZWJ families/professions, and invalid scalars.

Switching `terminal.unicode.activeVersion` must affect subsequent parsing/rendering/selection and
match reference version events/errors. Disposal unregisters provider behavior exactly as published.

### Step 6: Measure and optimize structural work

Benchmark search across large scrollback and serialization across large ranges. Avoid full-buffer
copies per keystroke, repeated UTF-16/cell maps, per-cell DOM nodes in HTML construction when spans
can be coalesced, and duplicate style passes. Record before/after throughput and peak memory.

### Step 7: Differentially certify and update the ledger

Run the shared corpus with multiple chunkings, sizes, normal/alternate buffers, modes, selection,
Unicode versions, and malformed patterns. Update only passing rows. Run full parity and repository
gates.

## Test plan

- Search tests cover direction, wrap, options, complex Unicode, highlights, limits, events, and
  disposal.
- Serialize round trips compare buffer/cursor/modes after restoration.
- HTML tests parse output and compare semantic DOM/style while probing escaping attacks.
- Unicode tests prove native cell widths and renderer continuation cells change together.
- Large-buffer benchmarks measure time and peak memory.

## Done criteria

- [ ] Official-vs-adapter decisions exist for all four addons.
- [ ] Search results, selection, decorations, limits, and events match reference behavior.
- [ ] VT serialization round-trips supported terminal state.
- [ ] HTML serialization is semantically compatible and injection-safe.
- [ ] Unicode 11 and grapheme providers alter authoritative native parsing/rendering.
- [ ] Large-buffer operations meet recorded performance/memory ceilings.
- [ ] All owned ledger rows are compatible with evidence.
- [ ] Focused, benchmark, parity, and full gates pass.
- [ ] Plan 012 is DONE.

## STOP conditions

Stop and report if:

- Search or serialization would read only the visible render frame.
- Round-trip fidelity requires state the native bridge still cannot expose.
- HTML compatibility would require unsafe raw markup emission.
- Unicode addon activation changes facade metadata but not native cell widths.
- The only route to official addon execution is fake xterm private services.
- Performance requires an always-live full-scrollback mirror.

## Maintenance notes

- Validate serialization by restoration, not string snapshots alone.
- Search decorations are derived state; native buffer content remains authoritative.
- Unicode version ids and behavior are public compatibility contracts.
