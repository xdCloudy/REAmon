# PyInstaller paired baseline run — 2026-11-09

This run compares the same pinned Linux x86_64 fixture (`ad8998bd53353c3f52c7c81a6bfb9251719da84541439ecf445b012f24188db0`) on the pre-evaluator source and the evaluator candidate.

- Baseline product source: `515d1b83d2a8772f4d816eb1efd690189bad2b2d`.
- Baseline measurement commit: `54ca0c1ff69468e1849a415c6a9e46825c61abe0`. This adds only the test evidence helper and integration test instrumentation; `webapp/src/lib/reamon/pyinstaller.ts` and `result-ingestion.ts` are unchanged from the baseline product source.
- Candidate source: `cb6a23a590c8aa1dbbf80cd094c4581ba30ed15a`.
- Both recorded receipts report clean worktrees and use the same fixture/evaluation manifest bytes and paired toolchain manifest.

The baseline and candidate both measured 180 extracted modules, 70/70 known-source value matches, a passing runtime oracle, and the queued worker terminal page. The comparator reports no regression in those measured metrics. Complete reconstruction correspondence remains `UNAVAILABLE`, so the aggregate result is `INCOMPLETE`; this single synthetic Python fixture does not pass AR-0/AR-8 or establish broad reconstruction fidelity.

`comparison.json` is bounded evidence, not a product certification. The original fixture source remains excluded from the analysis input.

## Superseded after provenance audit

This first paired archive is retained as historical evidence but is superseded by `../paired-canonical-lf/`. An audit found that the baseline merged evidence recorded LF manifest hashes while the candidate evidence recorded CRLF hashes from Windows `core.autocrlf` conversion. The initial receipt comparison had equal measured values, but its merged provenance did not bind both runs to the same raw manifest bytes. Use the canonical LF-stable pair for future comparisons.