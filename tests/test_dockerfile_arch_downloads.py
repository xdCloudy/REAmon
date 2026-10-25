"""Dockerfiles must download binaries for the image's architecture.

An amd64 tarball downloads, checksum-verifies and extracts fine inside an arm64
image; it only dies when executed ("Exec format error"), which on Apple Silicon
and ARM Linux hosts broke the install. On an x86 build host it is invisible,
because the kernel runs the x86 binary natively even in an emulated arm64
container. So the guard is textual: no download URL may name an x86 asset
literally; it must come from TARGETARCH / dpkg --print-architecture.

Pure text scan, no docker.
"""

import os
import re
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Vulnerable guinea-pig targets are built for x86 on purpose and never ship.
SKIP_DIRS = {".git", "node_modules", "guinea_pigs", ".next", "redamon.wiki"}

_URL = re.compile(r"https?://\S+")
_X86_ASSET = re.compile(r"amd64|x86_64|x86-64", re.IGNORECASE)
# Release-asset naming ('trufflehog_X_linux_amd64', 'go1.22.linux-amd64'), which
# also catches an asset name assembled in a shell variable rather than a URL.
_X86_ASSET_NAME = re.compile(r"linux[_-](amd64|x86_64)", re.IGNORECASE)


def _dockerfiles():
    for root, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if name == "Dockerfile" or name.startswith("Dockerfile."):
                yield os.path.join(root, name)


def _logical_lines(text):
    """Dockerfile instructions with backslash continuations joined."""
    return re.sub(r"\\\n", " ", text).splitlines()


class TestNoHardcodedX86Downloads(unittest.TestCase):

    def test_found_the_dockerfiles(self):
        found = {os.path.relpath(p, REPO) for p in _dockerfiles()}
        self.assertIn(os.path.join("scanners", "trufflehog_scan", "Dockerfile"), found)
        self.assertIn(os.path.join("agentic", "Dockerfile"), found)

    def test_no_download_url_names_an_x86_asset(self):
        offenders = []
        for path in _dockerfiles():
            with open(path, encoding="utf-8") as fh:
                for line in _logical_lines(fh.read()):
                    if line.lstrip().startswith("#"):
                        continue
                    hits = [u for u in _URL.findall(line) if _X86_ASSET.search(u)]
                    hits += [m.group(0) for m in _X86_ASSET_NAME.finditer(line)]
                    offenders += ["{}: {}".format(os.path.relpath(path, REPO), h)
                                  for h in hits]
        self.assertEqual(offenders, [], "hardcoded x86 download; derive the "
                         "architecture from TARGETARCH instead:\n" + "\n".join(offenders))

    def test_trufflehog_asset_follows_the_build_architecture(self):
        with open(os.path.join(REPO, "scanners", "trufflehog_scan", "Dockerfile")) as fh:
            text = fh.read()
        self.assertIn("ARG TARGETARCH", text)
        self.assertIn('asset="trufflehog_${TRUFFLEHOG_VERSION}_linux_${arch}.tar.gz"', text)
        # The checksum check and the exec smoke test are what catch a wrong asset.
        self.assertIn("sha256sum -c -", text)
        self.assertIn("/usr/local/bin/trufflehog --version", text)

    def test_agent_go_toolchain_uses_the_build_architecture(self):
        with open(os.path.join(REPO, "agentic", "Dockerfile")) as fh:
            text = fh.read()
        # Debian resolves golang-go for the target platform; executing it in
        # the image build catches a package/architecture mismatch.
        self.assertIn("    golang-go \\", text)
        self.assertIn("&& go version", text)


if __name__ == "__main__":
    unittest.main()
