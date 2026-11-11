Upstream: https://github.com/pkg/errors
Release/tag: v0.9.1
Commit: module proxy VCS origin is recorded in the test manifest.
Module checksum: h1:FEBLx1zS214owpjy7qsBeixbURkuhQAwrK5UwLGTwt4=
License: MIT; upstream LICENSE copied here.

This fixture contains the complete production Go source set of github.com/pkg/errors v0.9.1. The upstream release predates go.mod, so go.mod here is a minimal, hash-pinned module wrapper for the isolated helper and build checks; it is not presented as an upstream file. Only production sources are included. The go1.13 build-tagged go113.go file imports the standard library errors package as stderrors, with three selector references.