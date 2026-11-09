# Current-main Java fixture run — 2026-11-09

This run rebuilt the pinned, independently authored two-class Java fixture and
passed its original runtime oracle inside Docker. The JAR SHA-256 matches the
checked-in fixture manifest: `747346a392096bdac3613ac295ee4b8a743e22689a3738aeca1ad8ffc92fb7cf`.

CFR 0.152, through the live isolated `reamon-cfr` service, returned both expected
Java source paths with `truncated: false`. The recovered files compiled inside
the pinned Temurin 21 Docker image with `javac --release 17`, no network, 2 CPU,
and a 2 GiB memory cap. Running that derived class tree printed
`low:-15,high:42,high:22`, matching the original JAR's oracle. The service image
was `sha256:75c9a073878f7788ad2a488e27714b13738a303640d60031e47bb2e7c9059c06`;
the run ID is `cfr-20261109T183135-78db9a8c`.

`build-receipt.json`, `provider-receipt.json`, and `validation-receipt.json`
record the source and artifact hashes, provider outputs, repository revision,
runner hash, image IDs, compile command, and observed result. The artifact is
synthetic and two classes only. This run demonstrates one output that compiles
and matches one runtime oracle; it does not prove source equivalence, broad JVM
fidelity, multi-provider agreement, or a baseline-versus-candidate improvement.
