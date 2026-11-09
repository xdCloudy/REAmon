# PyInstaller v3 source-mutation control — 2026-11-09

This paired run tests the sensitivity of the structured-source matcher on the enrolled synthetic PyInstaller artifact. Both clean receipts use product commit `d6af8238324880e469a824a50ab51faedb33da9e`; the product revision is identical on both sides, so this checks repeatability and records no product improvement.

## Measured result

`comparison.json` reports `NO_REGRESSION_OBSERVED`, zero regressions, and clean receipts. Both direct-provider and queued-worker integrations passed 2/2 tests. The seven paired measurements were equal: runtime 1/1, extracted inventory 180/180, known values 70/70, original structured source matches 70/70, worker terminal page 1/1, seeded mutation rejections 70/70, and false acceptances 0/70.

For each of the 70 persisted recovered module sources, the integration harness changes the branch result `"below"` to `"under"`, then compares the mutated text against the fixture's independently retained expected source. The matcher rejected every mutation. The mutation is applied only to recovered text in the test harness; it is not supplied to the analyzer or executed as a binary.

## Scope and limits

This is a matcher sensitivity control for one behavior-changing return-string mutation in one synthetic Python 3.12.8 / PyInstaller 6.13.0 Linux fixture. It proves that this scorer detects the seeded difference on these 70 known modules. It does not measure how the provider reconstructs a separately mutated executable, cover malformed or obfuscated binaries, or establish general source fidelity or behavioral equivalence. The full `./redamon.sh test unit` gate was not run for this measurement.

## Provenance

The raw direct and worker integration evidence, merged baseline/candidate evidence, receipts, comparator output, toolchain manifest, and the exact fixture/evaluation/enrollment/build inputs used by the pair are included here. The receipts bind the clean commit, hashes, seven metric denominators, and toolchain revisions.
