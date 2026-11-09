# Unknown CArchive entry typecode rejection — 2026-11-09

After adding CArchive typecode validation, the same malformed artifact from
the prior run now receives HTTP 400 with failed status and no recovered
modules. Cookie preflight still accepts the artifact, confirming rejection
happens in the extractor's TOC parser. The fixed analyzer reports revision
`2aa0ec9e58317ac717fdeec84a02d5a67de7b96c2-reamon2` and image
`sha256:7bf15a8e6b41c1542d5cdcf6bc09bef3d6d890c2499548a06e93e27709dd5180`.

The tested artifact SHA-256 is
`6187e289c64edd4beac60e387bdbbd503b307bda266980c5f895fc1899e6a029`, the
same artifact that previously completed with an incomplete 179/180 inventory.
The post-fix staging receipt records `REMOVED_AFTER_HASH_CHECK`; the artifact
is not retained. Docker Go tests passed, and a disposable analyzer container
verified the live rejection without changing the running project service.
