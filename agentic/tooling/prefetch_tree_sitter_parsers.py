"""Install the pinned Tree-sitter parser bundle into REAmon's private cache."""

from __future__ import annotations

import hashlib
import io
import os
import re
import tarfile
import urllib.request
from importlib.metadata import version
from pathlib import Path, PurePosixPath

import zstandard


PACK_VERSION = "1.21.0"
RELEASE_ASSET_URL = (
    "https://api.github.com/repos/xberg-io/tree-sitter-language-pack/"
    "releases/assets/610577680"
)
RELEASE_ASSET_SHA256 = "579428269cf83f853bf42f647296588bb3864eab07d739495909b0ae49e310b5"
EXPECTED_LIBRARY_COUNT = 372
LIBRARY_NAME = re.compile(r"libtree_sitter_[a-zA-Z0-9_]+\.so\Z")


def main() -> None:
    installed_version = version("tree-sitter-language-pack")
    if installed_version != PACK_VERSION:
        raise RuntimeError(
            f"Expected tree-sitter-language-pack {PACK_VERSION}, got {installed_version}"
        )

    request = urllib.request.Request(
        RELEASE_ASSET_URL,
        headers={
            "Accept": "application/octet-stream",
            "User-Agent": "REAmon parser cache prefetch",
        },
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        archive_bytes = response.read()
    digest = hashlib.sha256(archive_bytes).hexdigest()
    if digest != RELEASE_ASSET_SHA256:
        raise RuntimeError(f"Tree-sitter parser archive SHA-256 mismatch: {digest}")

    cache_base = Path(os.environ["REAMON_TREE_SITTER_CACHE_DIR"])
    library_dir = (
        cache_base / "tree-sitter-language-pack" / f"v{PACK_VERSION}" / "libs"
    )
    library_dir.mkdir(parents=True, exist_ok=True)
    cache_directories = (
        cache_base,
        library_dir.parent.parent,
        library_dir.parent,
        library_dir,
    )
    for directory in cache_directories:
        os.chmod(directory, 0o700)

    extracted = 0
    decompressed = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(archive_bytes))
    with decompressed, tarfile.open(fileobj=decompressed, mode="r|") as archive:
        for member in archive:
            filename = PurePosixPath(member.name).name
            if not LIBRARY_NAME.fullmatch(filename):
                continue
            if not member.isfile() or member.name not in (filename, f"./{filename}"):
                raise RuntimeError(f"Unexpected Tree-sitter archive entry: {member.name}")
            source = archive.extractfile(member)
            if source is None:
                raise RuntimeError(f"Missing Tree-sitter parser bytes: {member.name}")
            target = library_dir / filename
            with source, target.open("wb") as destination:
                destination.write(source.read())
            os.chmod(target, 0o600)
            extracted += 1

    if extracted != EXPECTED_LIBRARY_COUNT:
        raise RuntimeError(
            f"Expected {EXPECTED_LIBRARY_COUNT} Tree-sitter parsers, extracted {extracted}"
        )

    print(f"Installed {extracted} Tree-sitter parser libraries in {library_dir}")


if __name__ == "__main__":
    main()
