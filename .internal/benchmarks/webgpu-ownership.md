# WebGPU benchmark ownership

The ordinary comparison entry passes the DOM host's renderer options directly to `WebGpuTerminalRenderer.create`. The selected runtime owns device acquisition, lifetime, and frame scheduling. Adapter provenance comes from the device the renderer actually uses. Preparing a terminal creates no additional device for observation.

Current production defaults share one device owner and frame coordinator within the main realm. A shared coordinator uses one browser animation callback to encode ready terminal frames, submit their command buffers, commit accepted frames, and notify observers. Each terminal retains its own resources and canvas. Worker realms and explicit device factories retain their separate ownership contracts.

Tracing records device, queue, device-owner, and coordinator identities. Each encoded command receives an identifier through a weak map. A successful grouped submission records the identifiers it actually submits. Presentation matching joins that command to its submission and requires both to belong to the same traced animation turn. Encoding alone and unrelated later submissions fail qualification. Direct-submission traces retain their original boundaries.

Historical evidence keeps its acquired runtime, benchmark source, and ownership configuration:

| Evidence                                                                     | Ownership qualification                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary comparison entry through `909b1312d02a9ca99a19ec5c10ddbf56b3f52ece` | The entry supplied one custom device factory per terminal. These main-realm measurements describe independent devices and submissions, including when the selected runtime contains PR 725.         |
| PR 725 production discriminator and common workload adapter                  | Their frozen adapters explicitly use production defaults. Recorded final-arm ownership is one device and queue, with coordinated submission. This harness correction does not change those results. |
| Architectural diagnostics with explicit factories or clocks                  | Retain each experiment's declared ownership arm. They qualify that configuration.                                                                                                                   |
| Dedicated-worker evidence                                                    | Retains its worker realm, transport, device, and clock qualification. Main-realm sharing does not qualify it.                                                                                       |

The corrected entry changes which ownership configuration future ordinary runs measure. Previous CPU ratios and presentation outcomes remain evidence of their original configurations. A software ownership or pixel check establishes correctness and mechanism. Hardware CPU and presentation comparisons require their own balanced acquisitions.
