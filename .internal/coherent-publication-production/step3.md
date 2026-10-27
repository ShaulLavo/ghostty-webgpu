# Observer text from retained frames

Status: Approved, pending the cumulative gate before publication.

Without a styled `onFrame` consumer, a retained subscriber supplies its text observers from its
own pending native capture. It no longer reads live text into the observer y-cache or re-extracts
the previous frame. Current and previous text share the subscriber's revision cache. Styled frame
consumers and the Canvas/DOM owned-row path retain their existing projections. Undemanded text
remains lazy. Failed retained extraction discards the pending native capture before retry.

The failing-first real-wasm test detects the redundant live read. It checks dense, scrolling,
Unicode, style and resize output, previous histories, and eager versus lazy demand through forty
frames. Another test injects retained extraction failure and retries different output. Browser
failure injection now targets the retained reader, while rich and supplied-row observer tests
remain. Observer options name only the callbacks and row count that the observer actually uses,
so the same real component can run under plain Node.

This step is held with steps 1 and 2 until main-reference heap is no higher, and dense and scroll
CPU both improve at sixteen terminals on PC and Mac. The exact 50,000-byte ownership guard and
all observer-equality checks remain hard gates. Raw evidence is in
`/work/reports/ghostty-webgpu-next-2026-10/x7-prod/step3/`.
