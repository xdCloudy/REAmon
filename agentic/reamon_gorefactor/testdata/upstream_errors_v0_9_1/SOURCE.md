# Pinned upstream Go fixture

- Project: `github.com/pkg/errors`
- Release: `v0.9.1`
- Source commit: `614d223910a179a466c1767a985424175c39b465` (tag `v0.9.1`)
- License: BSD 2-Clause; the upstream `LICENSE` file is preserved here.
- Source files: `errors.go` and `stack.go`, copied without modification from that commit.
- Purpose: independently authored two-file package fixture for cross-file function rename regression coverage. The unexported `callers` function is declared in `stack.go` and used by error constructors in `errors.go`.
- Scope: selected source files type-check together and exercise the rename; this is a narrow pinned fixture, not a representative Go accuracy corpus.

SHA-256:

| File | SHA-256 |
| --- | --- |
| `errors.go` | `71793fd94586f7261ab418566b3114f89bbbfda354ecf37c42f5b782315c4b4c` |
| `stack.go` | `8db3c35a432c18077f24f41b29e70adaea5ed9204ced729febf50dbac0e3d100` |
| `LICENSE` | `b6ac2b8efa0412a02a909080be694d88ed6a8b25b8041a48dd4d0c50dac785ad` |
