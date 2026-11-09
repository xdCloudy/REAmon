# Malformed PyInstaller TOC control — 2026-11-09

This control feeds a malformed CArchive to the running isolated PyInstaller
analyzer. The generated Linux x86-64 fixture passed its runtime oracle inside
the pinned Docker build container and the extractor inventoried 180 bytecode
modules in pages of 64, 64, and 52 before mutation. The target executable was
not run on the host.

## Mutation and response

The source artifact SHA-256 is
`3cc8501e4fb575089c808e8dda4a67d54ef5e949cac41ab03a52c11a71b2abc2`; the
malformed artifact SHA-256 is
`9ec52a09e4578a11dd85a5a0c6c7ffa4d4fbe4f6f88d79aa22cff753263216c4`. The
mutation changes only the first TOC entry-size field at byte offset `7264646`
from 32 to 17, below the 18-byte fixed header. The outer cookie and TOC bounds
remain valid, and the live service's `has_pyinstaller_cookie` check returned
true.

The running analyzer image was
`sha256:dfd6e00b359c5144b39510685e15faa4dbc48645b3b0f9fe5a39669e9e5a40d3`,
reported extractor revision
`2aa0ec9e58317ac717fdeec84a02d5a67de7b96c2-reamon1`, and was healthy. Its
HTTP endpoint returned 400 with `status: failed` and the generic
"unsupported or malformed" archive message. It returned no module payload.
The raw builder, mutation, and provider receipts are included here.

## Scope and limits

This proves rejection for one malformed TOC structure at the isolated
PyInstaller provider boundary. It does not test obfuscated archives, other
malformed structures, browser ingestion, PostgreSQL persistence, queued-worker
recovery, general malformed-input accuracy, or reconstruction fidelity. It
adds no weighted completion credit.
