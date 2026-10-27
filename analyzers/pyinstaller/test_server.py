import tempfile
import unittest
from pathlib import Path

import server


class CollectModulesPaginationTests(unittest.TestCase):
    def test_pages_over_the_module_cap_in_stable_order(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(70):
                (root / f"module_{index:03}.pyc").write_bytes(b"\x42\x43\r\n" + bytes([index]) * 12)

            first, first_bytes, count, next_offset = server.collect_modules(root)
            second, second_bytes, second_count, second_offset = server.collect_modules(root, next_offset)

            self.assertEqual((count, second_count), (70, 70))
            self.assertEqual((len(first), len(second)), (64, 6))
            self.assertEqual((next_offset, second_offset), (64, 70))
            self.assertEqual([module["moduleIndex"] for module in first], list(range(64)))
            self.assertEqual([module["moduleIndex"] for module in second], list(range(64, 70)))
            self.assertEqual(first[0]["archivePath"], "module_000.pyc")
            self.assertEqual(second[-1]["archivePath"], "module_069.pyc")
            self.assertEqual(first_bytes, sum(module["sizeBytes"] for module in first))
            self.assertEqual(second_bytes, sum(module["sizeBytes"] for module in second))

    def test_allows_an_empty_terminal_page_and_rejects_offsets_past_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "only.pyc").write_bytes(b"\x42\x43\r\n" + bytes(12))

            modules, output_bytes, count, next_offset = server.collect_modules(root, 1)

            self.assertEqual((modules, output_bytes, count, next_offset), ([], 0, 1, 1))
            with self.assertRaises(server.ExtractionError):
                server.collect_modules(root, 2)


if __name__ == "__main__":
    unittest.main()
