# Failed retry attempt retained

On the first candidate integration attempt (`mutated-candidate`), the queued
worker test passed. The direct PostgreSQL integration had already checked all
70 scored known modules, then failed at a final smoke assertion that selected
an arbitrary decompiled row and required its source file to be non-empty:

```text
AssertionError: expected 0 to be greater than 0
pyinstaller.task.database.integration.test.ts:268
```

The suite did not emit `integration-evidence.json` for that attempt, because its
evidence is written only after the direct test succeeds. A retry with a fresh
run ID (`mutated-candidate-retry1`) passed both tests and emitted the included
candidate evidence. The included baseline run also passed both tests. The
failure came from checking an unscored row after the known-module checks; the
integration test now hashes and verifies each scored source directly. This
note retains the observed failure, while the paired metrics remain limited to
the declared 70 known modules.
