# Pinned upstream Go fixture

- Project: `github.com/google/uuid`
- Release: `v1.6.0`
- Source commit: `0f11ee6918f41a04c201eceeadf612a377bc7fbc` (tag `v1.6.0`)
- License: BSD 3-Clause; the upstream `LICENSE` file is preserved here.
- Source files: `uuid.go`, `version4.go`, `util.go`, `hash.go`, `marshal.go`, and `sql.go`, copied without modification from that commit.
- Purpose: independently authored package subset for cross-file package binding renames. The unexported `rander` variable is declared in `uuid.go` and referenced in `version4.go` and `util.go`; the private `xtob` parser helper is declared in `util.go` and referenced in `uuid.go`.
- Scope: seven selected private package bindings are exercised, including six random-pool constants/variables and `xtob`. The selected files type-check together and test direct and pooled version-4 generation plus string/byte parsing and validation. This excludes build-constrained/node and other UUID-version files, so it is not a complete package checkout or a representative accuracy corpus.

SHA-256:

| File | SHA-256 |
| --- | --- |
| `uuid.go` | `707a63232670b23c8bb7e90fc4cbbfdaf0d2bff6a17734943fa0c476f182a741` |
| `version4.go` | `700f88aa406818aac89411773bb6395b278b4930f99b113558657333ab6c332a` |
| `util.go` | `1734f5bb243b580604adb97e53782c18fc0a2060178fb040dd82c893922b94fc` |
| `hash.go` | `bca77e48eea81ae9b514b4aaee29bc5ed09318e0a82f059338405f4eabc23045` |
| `marshal.go` | `f0e4e3651bacae9a6509e6d3e4fbacfe24adab91d87ece24cd70f0247b4464e0` |
| `sql.go` | `19710834cfcb61d444b5ca41e2c20a4bcea8834530c2b1ff1f592d0b95807c5f` |
| `LICENSE` | `f9e95f8256a9c54f6cff58d662d493cc9b8b36c7117a35d2d9e5174c229755ca` |
