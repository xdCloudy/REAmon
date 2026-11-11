Upstream: https://github.com/yuin/goldmark
Release/tag: v1.7.8
Commit: d9c03f07f08c2d36f23afe52dda865f05320ac86
Module checksum: h1:iERMLn0/QJeHFhxSt3p6PeN9mGnvIKSpG9YYorDMnic=
License: MIT; upstream LICENSE copied here.

The hash-pinned fixture contains the complete production Go source set (54 files) and go.mod for github.com/yuin/goldmark v1.7.8. The module has no external dependencies. Fourteen distinct import-alias bindings across `ast` and `extension` packages are exercised: `textm` (3 files, 17 resolved selectors) and `gast` (11 files, 159 resolved selectors). The acceptance submits them as one 14-binding module rename batch. The module's rendering behavior is checked with GFM extensions before and after the rename.