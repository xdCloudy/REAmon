Upstream: https://go.googlesource.com/sys
Release/tag: v0.6.0
Commit: c7a1bf9a0b0aa7c0c0e35a435924dd68e64d1653
Module checksum: h1:MVltZSvRTcU2ljQOhs94SXPftV6DCNnZViHeQps87pQ=
License: BSD-style; upstream LICENSE copied here.

The fixture contains the complete production source set for `golang.org/x/sys/windows` and its `internal/unsafeheader` dependency. Test files are excluded. Go build constraints select Windows/amd64 and Windows/arm64. Two explicit `errorspkg` aliases are exercised: one alias with one use in `exec_windows.go` and another with two uses in `syscall_windows.go`. Tests check each alias separately and as one coordinated batch, where a single request emits five declaration/reference edits across both files. The tagged module version and VCS origin were verified with the Go module proxy before inclusion.
