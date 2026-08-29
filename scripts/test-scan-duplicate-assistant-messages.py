#!/usr/bin/env python3
"""Tests for the read-only duplicate assistant message scanner."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("scan-duplicate-assistant-messages.py")
SPEC = importlib.util.spec_from_file_location("scan_duplicates", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class DuplicateScanTests(unittest.TestCase):
    def message(self, message_id: str, session_id: str, seconds: int, text: str) -> object:
        return MODULE.AssistantMessage(message_id, session_id, "parent-1", seconds * 1000, text)

    def test_exact_consecutive_duplicate_keeps_first(self) -> None:
        result = MODULE.scan([
            self.message("m1", "s1", 0, "same answer"),
            self.message("m2", "s1", 30, "same answer"),
            self.message("m3", "s1", 60, "different answer"),
        ], 600, 0.92)
        self.assertEqual(result["high_confidence_candidate_messages"], 1)
        self.assertEqual(result["high_confidence_groups"][0]["keep_message_id"], "m1")
        self.assertEqual(result["high_confidence_groups"][0]["message_ids"], ["m1", "m2"])

    def test_late_duplicate_is_not_a_candidate(self) -> None:
        result = MODULE.scan([
            self.message("m1", "s1", 0, "same answer"),
            self.message("m2", "s1", 601, "same answer"),
        ], 600, 0.92)
        self.assertEqual(result["high_confidence_candidate_messages"], 0)

    def test_different_parent_is_not_a_candidate(self) -> None:
        result = MODULE.scan([
            self.message("m1", "s1", 0, "same answer"),
            MODULE.AssistantMessage("m2", "s1", "parent-2", 30 * 1000, "same answer"),
        ], 600, 0.92)
        self.assertEqual(result["high_confidence_candidate_messages"], 0)

    def test_similar_content_is_review_only(self) -> None:
        result = MODULE.scan([
            self.message("m1", "s1", 0, "The deployment failed because the service is temporarily unavailable."),
            self.message("m2", "s1", 30, "The deployment failed because the service is temporarily unavailable right now."),
        ], 600, 0.92)
        self.assertEqual(result["high_confidence_candidate_messages"], 0)
        self.assertEqual(len(result["similar_pairs_review_only"]), 1)


if __name__ == "__main__":
    unittest.main()
