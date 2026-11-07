# Complete original browser font fixture preparation

Status: Approved source preparation. Native execution remains parent-owned.

The font-fixture stage selects all of `src/tests/fonts.browser.test.ts`.
The original file and `src/tests/fonts.ts` helper stay byte-identical to main
4346972d7a9e418cac8ad2614f1134706db60f11. The current canonical WORKERS.json,
including sourceSpecificPassedGroups and ghosttyOriginalBatch03Native, contains
no native completion receipt for this file. This adds no native credit.

The unchanged case fetches the actual locked JetBrains Mono WOFF2 asset,
requires HTTP 200, checks the wOF2 signature, and loads the same bytes with
FontFace. No generated replacement font or rewritten assertion is used.
There are no hooks, parameter rows, modes, geometry overrides, or explicit clocks.
The ordinary 15-second case and 30-second hook budgets and zero retries remain.

Only the existing ExpectedCase manifest, stage parser, source identity, and
focused guards change. The published Waffle 0.0.111 host, provider, runtime,
ordinary browser registration, packages, and lockfile stay unchanged.
Earlier ten complete original receipts remain separate and are not rerun.
The fixed 35 parked touch and 16 not-applicable records remain unchanged.
The whole browser root remains incomplete.
