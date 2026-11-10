# Changed-revision PyInstaller v3 comparison — 2026-11-10

This archive compares the enrolled 180-module PyInstaller fixture on two REAmon revisions using the same seven-metric contract and byte-identical measurement harness.

- Baseline product source: `87203c3f408d1d574c3d49f1d6af79274f57c569`.
- Baseline measurement checkout: `03abde37dc65d89a8b31801f34cefa962be00e29`, a clean, local harness-overlay commit. `baseline-measurement-overlay.patch` records the overlay; it pins the current integration test, evidence helper, receipt/compare tooling, runner and Compose file while retaining baseline product source.
- Candidate source: `c4d1e957b920e9f725db40266d81425852cd86fb`.
- Both live PostgreSQL/worker integration runs passed 2/2 tests. Both ran against the same enrolled artifact SHA-256 `746c550fc3324ebf285c0ee4a555ea2afb3d5b12c9c191eb2bf4f0978d263971` and identical toolchain manifest.
- The comparator returned `NO_REGRESSION_OBSERVED`, with clean receipts and zero delta for all seven metrics: module inventory 180/180; known-source value recall 70/70; structured reconstruction match 70/70; runtime oracle 1/1; worker terminal page 1/1; mutation rejection 70/70; false acceptance 0/70.

Scope limits: this is one synthetic PyInstaller fixture and one changed-revision slice. The fixture runtime oracle comes from its enrolled build receipt and was not executed separately during these two integration runs. Analyzer and task-worker service images were held fixed across both sides; this comparison does not evaluate changes to those external images or claim broad multi-format fidelity. It does not establish a product improvement because every compared metric was unchanged.

The Windows fixture build exposed CRLF drift on hashed text inputs. Explicit LF checkout rules now keep the requirements and license hashes stable. The fixture test now binds its extractor hashes to the immutable enrollment receipt; the build runner uses the current extractor and records its hashes in each new build receipt without rewriting enrollment. A fresh current build passed its runtime oracle and 180-module inventory, producing artifact SHA-256 `d143e8ae346ecdffbee8f5685bc22e3cc980d13668dc4b57703d8a69af84728c`; its separate receipt is `rebuild-current-build-receipt.json`. That newly built artifact differs from the enrolled artifact, so the changed-revision comparison above deliberately used the exact enrolled binary on both sides.
