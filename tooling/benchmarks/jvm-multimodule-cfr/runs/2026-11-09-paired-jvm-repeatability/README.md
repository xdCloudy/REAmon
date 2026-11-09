# Paired JVM repeatability receipt

Two independent live CFR 0.152 runs of the same held-out, synthetic two-class Java fixture, runner, product revision, pinned JDK, and provider image. Both runs recovered 2/2 expected source paths without truncation, compiled with `javac --release 17`, matched the fixture stdout oracle, and matched original `javap -p -s -c` output for both expected classes. Source and per-class bytecode hashes were identical across the runs.

The comparison is a same-revision repeatability measurement, not a product-change regression comparison. Exact bytecode disassembly correspondence on this one synthetic fixture does not prove original-source recovery or broad JVM fidelity.

See `repeatability-comparison.json` for the paired report and the provider/validation receipts for provenance and individual results.
