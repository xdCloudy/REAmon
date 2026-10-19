import unittest
import tempfile
import zipfile
from pathlib import Path

from server import build_decompile_command, extract_dex_inputs


class DecompilerCommandTests(unittest.TestCase):
    def test_uses_batch_slicer_with_shared_mapping_without_debug_bytecode(self):
        command = build_decompile_command(Path("classes.dex"), Path("names.txt"), Path("java"), 128, 64)

        self.assertEqual(
            command,
            ["/usr/local/bin/reamon-dex-batch", "classes.dex", "names.txt", "java", "128", "64"],
        )
        self.assertNotIn("--show-bytecode", command)
        self.assertNotIn("--deobf", command)

    def test_extracts_multidex_apks_in_numeric_order(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            apk = root / "fixture.apk"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("classes.dex", b"dex-one")
                archive.writestr("classes10.dex", b"dex-ten")
                archive.writestr("classes2.dex", b"dex-two")
                archive.writestr("assets/not-classes.dex", b"ignore")

            extracted = extract_dex_inputs(apk, ".apk", root / "dexes")

            self.assertEqual([name for _, name in extracted], ["classes.dex", "classes2.dex", "classes10.dex"])
            self.assertEqual([path.read_bytes() for path, _ in extracted], [b"dex-one", b"dex-two", b"dex-ten"])


if __name__ == "__main__":
    unittest.main()
