# Upload byte counters

WebGPU comparison traces record `bufferBytes` from the text pass's `frameUploadedBytes` value. This counts the actual lengths passed to `GPUQueue.writeBuffer`, including gaps introduced by bounding upload ranges and the private 80-byte GPU glyph layout. It does not measure driver copies or physical GPU transfer.

`canonicalRangeBytes` separately sums the requested native cell and glyph range lengths before coalescing and packing. Native glyph records remain 96 bytes. This sum can exceed actual uploads after packing or fall below them when coalescing uploads the gaps between requested ranges. Empty upload frames report zero for both counters.

Historical packets retain their original tracer source and field meanings. A WebGPU packet whose tracer sums native ranges into `bufferBytes` reports canonical requested lengths under that name. The current field definition does not relabel or rescore those sealed results.

The real-WebGPU regression check compares both counters with captured queue writes:

```sh
bun run test:browser src/render/tests/comparison-tracing.browser.test.ts
```
