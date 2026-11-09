# Renderer benchmark complete-file preparation

Status: Approved. Parent owns independent review, CI acceptance, merge, and native intake.

The sole original is `bench/renderer-benchmark.browser.test.ts`, unchanged from base
`6a64381d3a670d08c44fb3bc6f014d3475b1b194`, blob
`c770f19b041a7ea03f8c852969085c6fc873c904`. Its 3,813 bytes contain four expanded
rows from both tables, not a hardware performance qualification.

The `renderer-benchmark` stage follows the existing case manifest, full-byte hash,
options, and help pattern. Normal browser discovery already includes `bench/`.
The new metadata test never imports the original. The safe adapter list is the
33 batch 54 committed paths plus only this new committed test.

Real runtime and render state, native frame builders, measured OS monospace,
actual renderer factories, original submitted-frame waits, the real 80 ms idle
wait, error collection, and awaited cleanup remain unchanged. Pixel mode reaches
the existing dynamic compositor modules and Wasm. Optional URLs and dormant
factories are not counted as asset requests.

The packet is at
`/work/reports/wave-20261108/ios-suites/ghostty-next-complete-original-batch57/packet/`.
It binds source, normal inputs, generated builds, both tables, actual served
modules and responses, immutable exclusion maps, and the saved desktop result.
No native result, real-pixel qualification, or complete-root claim is made.
