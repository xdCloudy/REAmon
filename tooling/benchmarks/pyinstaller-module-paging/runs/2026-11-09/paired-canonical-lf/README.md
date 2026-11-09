# Canonical LF-stable PyInstaller pair — 2026-11-09

This is the authoritative paired run. Benchmark JSON now has LF checkout rules, and the raw hashes of the fixture manifest, evaluation manifest, and enrollment receipt matched across clean baseline and candidate checkouts. The same canonical files were used by both evidence merges and receipts.

- Baseline product source: `515d1b83d2a8772f4d816eb1efd690189bad2b2d`.
- Baseline measurement source: `2f88d34ba9e30d5da9168171565302c5b5e64c1a` (test instrumentation and LF-stable benchmark JSON attributes on top of the baseline product source).
- Candidate source: `4a93d892d2784ee569725cc8c70529d172a53b44`.
- Both live integration runs passed direct PostgreSQL persistence and queued-worker tests against artifact SHA-256 `ad8998bd53353c3f52c7c81a6bfb9251719da84541439ecf445b012f24188db0`.
- Both clean receipts use the same fixture, evaluation, and paired toolchain hashes.

The measured runtime oracle (1/1), extracted inventory (180/180), known-source values (70/70), and worker terminal page (1/1) are equal. The comparator found no regression among those metrics. Full reconstruction correspondence remains `UNAVAILABLE`, so the aggregate result is `INCOMPLETE`. One synthetic Python fixture does not pass AR-0/AR-8 or establish broad reconstruction fidelity.

`comparison.json` is bounded evidence, not a product certification. Ground-truth source was not mounted into the analysis services.
