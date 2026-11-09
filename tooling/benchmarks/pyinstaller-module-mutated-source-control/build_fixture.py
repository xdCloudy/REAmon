"""Build a PyInstaller fixture whose known source changes one branch result."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

MODULE_COUNT = 70
EXPECTED_VALUE = sum(range(1, MODULE_COUNT + 1))


def module_source(value: int) -> str:
    return (
        f"VALUE = {value}\n"
        "def classify(candidate):\n"
        "    if candidate < VALUE:\n"
        "        return \"under\"\n"
        "    return \"at-or-above\"\n"
    )


def build(output: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="reamon-pyi-mutated-source-") as temporary:
        root = Path(temporary)
        package = root / "paging_fixture"
        package.mkdir()
        (package / "__init__.py").write_text("", encoding="utf-8")
        for index in range(MODULE_COUNT):
            (package / f"module_{index:03}.py").write_text(
                module_source(index + 1), encoding="utf-8"
            )

        names = [f"paging_fixture.module_{index:03}" for index in range(MODULE_COUNT)]
        imports = ", ".join(repr(name) for name in names)
        main = root / "main.py"
        main.write_text(
            "import importlib\n"
            f"MODULES = ({imports},)\n"
            "assert importlib.import_module(MODULES[0]).classify(0) == 'under'\n"
            "assert importlib.import_module(MODULES[0]).classify(1) == 'at-or-above'\n"
            "print(sum(importlib.import_module(name).VALUE for name in MODULES))\n",
            encoding="utf-8",
        )
        command = [
            "pyinstaller", "--clean", "--noconfirm", "--onefile",
            "--name", "pyinstaller-module-structured-source-mutated",
            "--distpath", str(root / "dist"),
            "--workpath", str(root / "work"),
            "--specpath", str(root / "spec"),
            "--paths", str(root),
            *(argument for name in names for argument in ("--hidden-import", name)),
            str(main),
        ]
        subprocess.run(command, check=True, cwd=root)

        binary = root / "dist" / "pyinstaller-module-structured-source-mutated"
        result = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
        if result.stdout.strip() != str(EXPECTED_VALUE):
            raise RuntimeError(f"fixture oracle mismatch: expected {EXPECTED_VALUE}, got {result.stdout!r}")
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(binary, output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(args.output)


if __name__ == "__main__":
    main()
