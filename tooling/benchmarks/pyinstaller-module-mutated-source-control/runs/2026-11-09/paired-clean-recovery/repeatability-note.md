# Failed retry attempt retained

On the first candidate integration attempt (`mutated-candidate`), the queued
worker test passed. The direct PostgreSQL integration failed at the assertion
that the persisted source file must be non-empty:

```text
AssertionError: expected 0 to be greater than 0
pyinstaller.task.database.integration.test.ts:268
```

The suite did not emit `integration-evidence.json` for that attempt, because its
evidence is written only after the direct test succeeds. A retry with a fresh
run ID (`mutated-candidate-retry1`) passed both tests and emitted the included
candidate evidence. The included baseline run also passed both tests. This note
records the observed flake; the retry does not erase it.
