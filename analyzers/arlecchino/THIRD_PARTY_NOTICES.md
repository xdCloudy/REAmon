# Third-party notices

REAmon's Arlecchino adapter builds the upstream Apache-2.0 CLI at commit
`de3e7b0bbc4c99d45a5baa63f8f8f05532b80363`. Its `LICENSE` and `NOTICE` are installed
under `/usr/share/licenses/arlecchino/`.

The image also installs these separately licensed command-line engines and libraries:

| Component | Version | License |
| --- | --- | --- |
| Vineflower | 1.12.0 | Apache-2.0 |
| CFR | 0.152 | MIT |
| JADX | 1.5.6 | Apache-2.0 |
| ObjectWeb ASM | 9.7 | BSD-3-Clause |

Their release artifacts remain separate processes or dependencies and are not merged
into REAmon's source. License texts for the bundled engines and ASM are installed in
`/usr/share/licenses/arlecchino/` and `/usr/share/licenses/jadx/`. Arlecchino's
third-party Rust crate notices are included in its upstream `NOTICE` file.
