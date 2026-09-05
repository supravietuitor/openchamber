#!/usr/bin/env python3
"""Regression tests for the historical polluted-message migration."""

from __future__ import annotations

import importlib.util
import gc
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("cleanup-polluted-assistant-messages.py")
SPEC = importlib.util.spec_from_file_location("cleanup_polluted", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


SCHEMA = """
CREATE TABLE session (id TEXT PRIMARY KEY);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES message(id) ON DELETE CASCADE);
"""


def make_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.execute("INSERT INTO session VALUES ('ses_1')")
    rows = [
        ("msg_user", "ses_1", "user", "Keep this user message."),
        ("msg_clean", "ses_1", "assistant", "The build failed. No final artifact was generated."),
        ("msg_mixed", "ses_1", "assistant", "正常结论。\nThis is clearly a system loop.\nNo final."),
        ("msg_pure", "ses_1", "assistant", "I failed.\nThis is clearly a system loop.\nNo final."),
    ]
    for index, (message_id, session_id, role, text) in enumerate(rows):
        conn.execute("INSERT INTO message VALUES (?, ?, ?, ?)", (message_id, session_id, index, json.dumps({"id": message_id, "sessionID": session_id, "role": role})))
        conn.execute("INSERT INTO part VALUES (?, ?, ?, ?, ?)", (f"part_{message_id}", message_id, index, index, json.dumps({"id": f"part_{message_id}", "type": "text", "text": text})))
    conn.commit()
    conn.close()


class CleanupMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "opencode.db"
        make_db(self.db)

    def tearDown(self) -> None:
        gc.collect()
        self.temp.cleanup()

    def test_dry_run_does_not_create_backup_or_modify_database(self) -> None:
        with sqlite3.connect(self.db) as conn:
            before = conn.execute("SELECT id, data FROM part ORDER BY id").fetchall()
        report = MODULE.migrate(self.db, apply=False)
        with sqlite3.connect(self.db) as conn:
            after = conn.execute("SELECT id, data FROM part ORDER BY id").fetchall()
        self.assertEqual(report.matched_messages, 2)
        self.assertEqual(before, after)
        self.assertEqual(list(Path(self.temp.name).glob("*.backup.sqlite")), [])

    def test_apply_creates_backup_and_preserves_user_and_clean_messages(self) -> None:
        report = MODULE.migrate(self.db, apply=True)
        self.assertIsNotNone(report.backup_path)
        self.assertTrue(Path(report.backup_path).exists())
        conn = sqlite3.connect(self.db)
        message_ids = {row[0] for row in conn.execute("SELECT id FROM message")}
        self.assertEqual(message_ids, {"msg_user", "msg_clean", "msg_mixed"})
        mixed = conn.execute("SELECT data FROM part WHERE message_id = 'msg_mixed'").fetchone()[0]
        self.assertEqual(json.loads(mixed)["text"], "正常结论。")
        self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        conn.close()

    def test_failure_rolls_back_all_mutations(self) -> None:
        with sqlite3.connect(self.db) as conn:
            before = conn.execute("SELECT id, data FROM message ORDER BY id").fetchall()
        conn = sqlite3.connect(self.db)
        _, changes, deleted = MODULE.collect_changes(conn)
        conn.close()
        with self.assertRaises(RuntimeError):
            MODULE.apply_changes(self.db, changes, deleted, fail_after=1)
        with sqlite3.connect(self.db) as conn:
            after = conn.execute("SELECT id, data FROM message ORDER BY id").fetchall()
        self.assertEqual(before, after)
        with sqlite3.connect(self.db) as conn:
            self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_default_scan_covers_all_sessions(self) -> None:
        conn = sqlite3.connect(self.db)
        conn.execute("INSERT INTO session VALUES ('ses_2')")
        message_id = "msg_other_session"
        conn.execute("INSERT INTO message VALUES (?, ?, ?, ?)", (message_id, "ses_2", 10, json.dumps({"id": message_id, "sessionID": "ses_2", "role": "assistant"})))
        conn.execute("INSERT INTO part VALUES (?, ?, ?, ?, ?)", ("part_other", message_id, 10, 10, json.dumps({"id": "part_other", "type": "text", "text": "I failed.\nThis is clearly a system loop."})))
        conn.commit()
        conn.close()

        report = MODULE.migrate(self.db, apply=False)
        self.assertIn("ses_1", report.matched_by_session)
        self.assertIn("ses_2", report.matched_by_session)


if __name__ == "__main__":
    unittest.main()
