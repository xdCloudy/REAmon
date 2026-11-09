# Malformed CArchive entry-extent control — 2026-11-09

This third malformed control changes only the first entry-size field in the
pinned structured-source fixture. The CArchive cookie and TOC bounds remain
valid, but the entry's declared extent exceeds the full TOC region.

The fixture artifact SHA-256 is
`3cc8501e4fb575089c808e8dda4a67d54ef5e949cac41ab03a52c11a71b2abc2`; the
mutated artifact SHA-256 is
`3b9eacdc4fe7087204ccb8d750bcd2de2c143e64f438421c9c3c1d13a422f49a`. The
mutation changes the 4-byte field at offset `7264646` from `32` to `3601`,
while the declared TOC size is `3600` bytes.

The running analyzer image was
`sha256:dfd6e00b359c5144b39510685e15faa4dbc48645b3b0f9fe5a39669e9e5a40d3`,
with extractor revision
`2aa0ec9e58317ac717fdeec84a02d5a67de7b96c2-reamon1`. Cookie preflight
accepted the artifact. The live provider returned HTTP 400 with failed status
and no recovered modules, so the control passed. Hash-bound cleanup removed
the staged file and a follow-up check confirmed the path was absent. The
executable was never run on the host and is not retained here.

This measures one malformed entry-extent case at the isolated provider
boundary. Together with the other two archived controls, it covers three
specific malformed TOC conditions; it does not establish general malformed
input accuracy, obfuscation coverage, worker behavior, or reconstruction
fidelity.
