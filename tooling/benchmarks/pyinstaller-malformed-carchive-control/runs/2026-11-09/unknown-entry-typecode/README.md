# Unknown CArchive entry typecode control — 2026-11-09

This malformed-input control changes the first CArchive TOC entry's one-byte
typecode from `m` (module) to `?`. The cookie preflight accepted the artifact,
but the live analyzer returned HTTP 200 with `status: completed` and reported
179 modules, while the clean fixture inventory is 180. The unknown entry was
silently omitted instead of causing rejection. The control is marked PASS for
reproducing this measured behavior, not as a safe-rejection result.

The clean artifact SHA-256 is
`3cc8501e4fb575089c808e8dda4a67d54ef5e949cac41ab03a52c11a71b2abc2`; the
mutated artifact SHA-256 is
`6187e289c64edd4beac60e387bdbbd503b307bda266980c5f895fc1899e6a029`. The
mutation changes only byte `7264663`. The running analyzer image was
`sha256:dfd6e00b359c5144b39510685e15faa4dbc48645b3b0f9fe5a39669e9e5a40d3`,
with extractor revision
`2aa0ec9e58317ac717fdeec84a02d5a67de7b96c2-reamon1`. The staged artifact
was removed after its hash was verified; no target executable was run on the
host or retained in the archive.

This is one malformed-typecode behavior at the isolated provider boundary. It
does not measure project-level impact, worker behavior, or reconstruction
fidelity. The 179/180 result is an inventory-loss signal that requires broader
format and control coverage before generalizing.
