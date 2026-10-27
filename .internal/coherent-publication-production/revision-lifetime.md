# Collision-free revision lifetime

Status: Approved review correction for PRs 34–36.

The review seeded an accepted native counter to `0xffffffff` while a clean header still owned
revision 1. Rewriting the body reused revision 1, and the cache returned the header at both row
positions. The failing-first real-wasm test reproduces that exact stale-text result.

Native row revisions and their allocation counter now use `u64`. The bridge exports exact f64
numbers to the JS number-keyed cache. Allocation stops at `Number.MAX_SAFE_INTEGER`; exhaustion
returns an unsuccessful capture before a dirty row is overwritten. A revision therefore never
wraps or rounds into a readable history key. Clearing only the JS map is not used as a remedy.
The opaque Frame has an explicit C layout, making the forced-boundary fixture's wasm32 counter
offset stable without a production counter-setting API.

The regression covers the former 32-bit boundary, independent clean header and changed body
positions, discard with different retry output, previous accepted rows, the last representable
revision, and rejected exhaustion with the accepted frame still readable. The 50,000-byte owned
row guard remains part of every layer's ordinary Node suite.

Because allocation and revision export are on the publication path, cumulative headed hardware
pairs are rechecked on PC and Mac. All layers repeat build, extension preparation, static checks,
unit tests, the full browser suite and docs checks before updating the PRs. Evidence belongs to
`/work/reports/ghostty-webgpu-next-2026-10/x7-prod/revision-fix/`.
