"""Hermetic checks for the matched clean and obfuscated fixture sources."""

from __future__ import annotations

import unittest

from build_fixture import (
    MODULE_COUNT,
    EXPECTED_VALUE,
    clean_module_source,
    encoded_string,
    main_source,
    obfuscated_module_source,
)


class ObfuscationFixtureTests(unittest.TestCase):
    def test_clean_and_obfuscated_controls_share_the_same_known_value(self) -> None:
        self.assertEqual(EXPECTED_VALUE, 2485)
        self.assertEqual(MODULE_COUNT, 70)

    def test_obfuscated_module_renames_recovered_symbols(self) -> None:
        source = obfuscated_module_source(3)
        self.assertIn("def _1(_2):", source)
        self.assertIn("def _3(_4):", source)
        self.assertNotIn("def classify", source)
        self.assertNotIn("candidate", source)

    def test_obfuscated_module_encodes_behavioral_strings(self) -> None:
        source = obfuscated_module_source(3)
        self.assertNotIn("below", source)
        self.assertNotIn("at-or-above", source)
        self.assertIn(repr(encoded_string("below")), source)
        self.assertIn(repr(encoded_string("at-or-above")), source)

    def test_matched_entrypoints_check_the_same_behavior(self) -> None:
        clean = main_source(["clean_fixture.module_000"], obfuscated=False)
        obfuscated = main_source(["obfuscated_fixture.m000"], obfuscated=True)
        self.assertIn("== 'below'", clean)
        self.assertIn("== 'below'", obfuscated)
        self.assertIn("print(sum(", clean)
        self.assertIn("print(sum(", obfuscated)


if __name__ == "__main__":
    unittest.main()
