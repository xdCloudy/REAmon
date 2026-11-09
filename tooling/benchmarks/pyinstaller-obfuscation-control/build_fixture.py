"""Build matched clean and source-obfuscated PyInstaller controls."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

MODULE_COUNT = 70
EXPECTED_VALUE = sum(range(1, MODULE_COUNT + 1))
OBFUSCATION_KEY = 91


def clean_module_source(value: int) -> str:
    return (
        f"VALUE = {value}\n"
        "def classify(candidate):\n"
        "    if candidate < VALUE:\n"
        "        return 'below'\n"
        "    return 'at-or-above'\n"
    )


def encoded_string(value: str) -> tuple[int, ...]:
    return tuple(ord(character) ^ OBFUSCATION_KEY for character in value)


def obfuscated_module_source(value: int) -> str:
    below = encoded_string("below")
    at_or_above = encoded_string("at-or-above")
    return (
        f"_0 = {value}\n"
        "def _1(_2):\n"
        "    if _2 < _0:\n"
        f"        return _3(bytes({below!r}))\n"
        f"    return _3(bytes({at_or_above!r}))\n"
        f"def _3(_4):\n"
        f"    return ''.join(chr(_5 ^ {OBFUSCATION_KEY}) for _5 in _4)\n"
    )


def write_variant(root: Path, package_name: str, obfuscated: bool) -> list[str]:
    package = root / package_name
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    module_names: list[str] = []
    for index in range(MODULE_COUNT):
        module_name = f"m{index:03}" if obfuscated else f"module_{index:03}"
        (package / f"{module_name}.py").write_text(
            (obfuscated_module_source if obfuscated else clean_module_source)(index + 1),
            encoding="utf-8",
        )
        module_names.append(f"{package_name}.{module_name}")
    return module_names


def main_source(module_names: list[str], obfuscated: bool) -> str:
    imports = ", ".join(repr(name) for name in module_names)
    if obfuscated:
        return (
            "import importlib\n"
            f"_6 = ({imports},)\n"
            "_7 = importlib.import_module(_6[0])\n"
            "assert _7._1(0) == 'below'\n"
            "assert _7._1(_7._0) == 'at-or-above'\n"
            "print(sum(importlib.import_module(_8)._0 for _8 in _6))\n"
        )
    return (
        "import importlib\n"
        f"MODULES = ({imports},)\n"
        "assert importlib.import_module(MODULES[0]).classify(0) == 'below'\n"
        "assert importlib.import_module(MODULES[0]).classify(1) == 'at-or-above'\n"
        "print(sum(importlib.import_module(name).VALUE for name in MODULES))\n"
    )


def build_variant(output_root: Path, artifact_name: str, obfuscated: bool) -> None:
    with tempfile.TemporaryDirectory(prefix=f"reamon-pyi-{artifact_name}-") as temporary:
        root = Path(temporary)
        package_name = "obfuscated_fixture" if obfuscated else "clean_fixture"
        module_names = write_variant(root, package_name, obfuscated)
        main = root / "main.py"
        main.write_text(main_source(module_names, obfuscated), encoding="utf-8")
        command = [
            "pyinstaller", "--clean", "--noconfirm", "--onefile",
            "--name", artifact_name,
            "--distpath", str(root / "dist"),
            "--workpath", str(root / "work"),
            "--specpath", str(root / "spec"),
            "--paths", str(root),
            *(argument for name in module_names for argument in ("--hidden-import", name)),
            str(main),
        ]
        subprocess.run(command, check=True, cwd=root)
        binary = root / "dist" / artifact_name
        result = subprocess.run([str(binary)], check=True, capture_output=True, text=True)
        if result.stdout.strip() != str(EXPECTED_VALUE):
            raise RuntimeError(
                f"{artifact_name} runtime oracle mismatch: expected {EXPECTED_VALUE}, "
                f"got {result.stdout!r}"
            )
        output_root.mkdir(parents=True, exist_ok=True)
        shutil.copy2(binary, output_root / artifact_name)


def build(output_root: Path) -> None:
    if output_root.exists() and any(output_root.iterdir()):
        raise FileExistsError(f"refusing non-empty output directory: {output_root}")
    build_variant(output_root, "pyinstaller-obfuscation-clean", obfuscated=False)
    build_variant(output_root, "pyinstaller-obfuscation-obfuscated", obfuscated=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    build(args.output_dir)


if __name__ == "__main__":
    main()
