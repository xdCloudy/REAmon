Upstream: https://github.com/buger/jsonparser
Release/tag: v1.1.1
Commit: df3ea76ece10095374fd1c9a22a4fb85a44efc42
Module checksum: h1:2PnMjfWD7wBILjqQbt530v576A/cAbQvEW9gGIpYMUs=
License: MIT; upstream LICENSE copied here.

The fixture contains the complete production Go source set for github.com/buger/jsonparser v1.1.1. Its `bytes.go` file aliases the standard library `bytes` package as `bio`; that alias is used once in the signed-int64 boundary parser. `bytes_safe.go` and `bytes_unsafe.go` exercise the upstream appengine build constraints. The upstream go.mod is included unchanged; the module has no external dependencies.