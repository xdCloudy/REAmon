# Malformed CArchive entry-position control — 2026-11-09

This is a second malformed TOC control, separate from the first-entry-size
control. It changes only the first entry's data position. The base artifact
passed its Docker runtime oracle and has SHA-256
`3cc8501e4fb575089c808e8dda4a67d54ef5e949cac41ab03a52c11a71b2abc2`.

## Mutation and provider response

The CArchive cookie is at byte offset `7268246`, and the first TOC entry begins
at `7264646`. The entry-size value remains 32. The data-position field at
`7264650` changes from 0 to `7216496`, one byte beyond the computed overlay size
`7216495`. The mutated artifact SHA-256 is
`137b021dee976064592ad383f5e0fdde7259a209498eaabd6b83a72dba36b417`.

The running analyzer image was
`sha256:dfd6e00b359c5144b39510685e15faa4dbc48645b3b0f9fe5a39669e9e5a40d3`,
extractor revision
`2aa0ec9e58317ac717fdeec84a02d5a67de7b96c2-reamon1`. Its own cookie
preflight accepted the artifact. The live endpoint then returned HTTP 400,
`status: failed`, the generic unsupported/malformed message, and no modules
payload. The control result is PASS.

The staging receipt binds the copied file to the mutation hash and records
`REMOVED_AFTER_HASH_CHECK`. A separate read-only volume check confirmed the
staging path was absent after the run. The mutated executable is not retained.

## Scope and limits

This measures rejection for one out-of-bounds CArchive entry data position at
the isolated PyInstaller provider boundary; no target execution occurred on the
host. Together with the undersized-entry control, this covers two malformed TOC
conditions. Other malformed layouts, obfuscation, database persistence,
queued-worker behavior, and reconstruction fidelity remain unmeasured.
