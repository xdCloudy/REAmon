import unittest
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

from server import (
    AnalysisError,
    build_decompile_command,
    build_mapping_command,
    clamp_class_batch_size,
    create_analysis_tempdir,
    extract_dex_inputs,
    parse_dex_inventory,
    recover_batch_class_failures,
    reconcile_dex_inventory,
    should_report_class_batch,
)


class DecompilerCommandTests(unittest.TestCase):
    def test_class_batch_size_can_isolate_single_classes_with_safe_bounds(self):
        self.assertEqual(clamp_class_batch_size(1), 1)
        self.assertEqual(clamp_class_batch_size(0), 1)
        self.assertEqual(clamp_class_batch_size(64), 64)
        self.assertEqual(clamp_class_batch_size(10_000), 256)

    def test_single_class_progress_is_throttled_and_batch_retries_remain_visible(self):
        self.assertFalse(should_report_class_batch(1, 1, 128))
        self.assertTrue(should_report_class_batch(64, 1, 128))
        self.assertTrue(should_report_class_batch(127, 1, 128))
        self.assertTrue(should_report_class_batch(1, 2, 128))

    def test_request_scratch_directory_uses_configured_volume_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            scratch_root = Path(temporary) / "scratch"
            stale = scratch_root / "reamon-dex-decompiler-abandoned"
            stale.mkdir(parents=True)
            (stale / "partial.dex").write_bytes(b"partial")
            with patch("server.SCRATCH_ROOT", scratch_root):
                with create_analysis_tempdir() as work_directory:
                    self.assertEqual(Path(work_directory).parent, scratch_root)
                    self.assertTrue(Path(work_directory).is_dir())
                    self.assertFalse(stale.exists())

    def test_request_scratch_capacity_failure_is_actionable(self):
        with patch("server.tempfile.TemporaryDirectory", side_effect=OSError("no space left")):
            with self.assertRaisesRegex(AnalysisError, "scratch storage is unavailable or full"):
                create_analysis_tempdir()

    def test_uses_batch_slicer_with_shared_mapping_and_structured_mode(self):
        command = build_decompile_command(Path("classes.dex"), Path("names.txt"), Path("java"), 128, 64)

        self.assertEqual(
            command,
            ["/usr/local/bin/reamon-dex-batch", "classes.dex", "names.txt", "java", "128", "64", "restructure"],
        )
        self.assertNotIn("--show-bytecode", command)
        self.assertNotIn("--deobf", command)

    def test_can_request_lower_memory_modes_for_a_single_class_retry(self):
        for mode in ("simple", "fallback"):
            with self.subTest(mode=mode):
                command = build_decompile_command(
                    Path("classes.dex"), Path("names.txt"), Path("java"), 7, 1, mode,
                )

                self.assertEqual(command[-3:], ["7", "1", mode])

    def test_builds_one_accumulated_map_from_each_extracted_dex(self):
        command = build_mapping_command(Path("classes2.dex"), Path("project-map.txt"))

        self.assertEqual(
            command,
            ["/usr/local/bin/reamon-dex-map", "classes2.dex", "project-map.txt"],
        )

    def test_reads_inventory_even_when_map_generation_fails_after_inventory(self):
        self.assertEqual(parse_dex_inventory(b'{"discoveredClassCount": 123}\n'), 123)
        self.assertIsNone(parse_dex_inventory(b"map generation failed"))

    def test_preserves_inventory_when_every_decompilation_retry_lacks_a_summary(self):
        self.assertEqual(reconcile_dex_inventory(1, None, "classes2.dex"), 1)
        self.assertIsNone(reconcile_dex_inventory(None, None, "classes2.dex"))

    def test_retries_only_reported_class_failures_and_reconciles_counts_once(self):
        summary = {
            "discoveredClassCount": 12,
            "returnedClassCount": 7,
            "failedClassCount": 2,
            "failedClassIndices": [4, 9],
        }
        attempted = []

        def retry(class_index):
            attempted.append(class_index)
            if class_index == 4:
                return 12, 1, 0
            return None, 0, 1

        returned, failed, retries = recover_batch_class_failures(summary, 0, 12, retry)

        self.assertEqual(attempted, [4, 9])
        self.assertEqual((returned, failed), (8, 1))
        self.assertEqual(retries, [(12, 1, 0), (None, 0, 1)])

    def test_keeps_failure_count_when_batch_does_not_identify_failed_indexes(self):
        summary = {
            "returnedClassCount": 3,
            "failedClassCount": 1,
            "failedClassIndices": [99],
        }
        attempted = []

        returned, failed, retries = recover_batch_class_failures(
            summary,
            0,
            4,
            lambda index: attempted.append(index) or (4, 1, 0),
        )

        self.assertEqual((returned, failed), (3, 1))
        self.assertIsNone(retries)
        self.assertEqual(attempted, [])

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
