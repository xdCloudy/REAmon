# PyInstaller exact-source v2 pair — 2026-11-09

This pair validates the v2 measurement contract on the same enrolled artifact.
Baseline source is `515d1b83d2a8772f4d816eb1efd690189bad2b2d` with the identical
source-matching evidence harness committed as measurement revision
`d0d7ec943b3a243ddc3e6dc2dec8cef30fa43002`. Candidate revision is
`b62277abcc5038df74517dd0bd7bc1f08ad083e2`. The PyInstaller provider and result
ingestion source files are unchanged between product baseline and candidate.

Both direct PostgreSQL integrations and queued-worker checks passed against the
same fixture artifact
`ad8998bd53353c3f52c7c81a6bfb9251719da84541439ecf445b012f24188db0`. The v2
source metric strips comments and whitespace and requires each recovered module
to consist only of the expected `VALUE = N` assignment. It measured 70/70 exact
source matches on both sides. The other measured results were 180/180 extracted
modules, 70/70 known-source values, runtime oracle 1/1, and worker terminal page
1/1. All deltas were zero; no regression was observed.

Both receipts are clean and use the same v2 evaluation manifest, fixture,
enrollment receipt, build receipt, and toolchain manifest. The comparison is
bounded evidence, not product certification. It covers 70 trivial single-
assignment modules in one synthetic Python/PyInstaller artifact; the other 110
extracted modules, full project structure, dependencies, symbols, and types are
not scored. This measures the baseline and candidate with the same provider
source, so it verifies evaluator behavior and reports no product code change.
