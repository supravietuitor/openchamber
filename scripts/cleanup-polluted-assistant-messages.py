#!/usr/bin/env python3
"""OpenChamber migration: back up and remove historical polluted assistant text."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


DEFAULT_DB = Path(r"D:\AI\Memory\opencode\opencode.db")

POLLUTION_PATTERNS = (
    (re.compile(r"(?<=[。.!?])\s*(?:_久久爱(?:\s+六合彩[?？]?)?|六合彩[?？]?|porn(?:filmer)?(?:\.\.\.)?|geeky\?|\bBaebele\b|\bNow ending\.|>xpath\b|invalid\.?|Winvalid\.?)\s*$", re.I), False),
    (re.compile(r"(?:^|\n)\s*(?:I failed\.?|No final\??|No output\.?|Stop\.?|End\.?|\[END\])\s*(?:\n|$)", re.I), True),
    (re.compile(r"\bThis is (?:clearly )?a system loop\b", re.I), True),
    (re.compile(r"\bThis is analysis, not user visible\b", re.I), True),
    (re.compile(r"\bI (?:need|must) (?:just )?stop producing tokens\b", re.I), True),
    (re.compile(r"\bNo more channel calls\b", re.I), True),
    (re.compile(r"\banalysis channel ongoing\b", re.I), True),
    (re.compile(r"\b(?:the )?harness keeps generation\b", re.I), True),
)


@dataclass
class PartChange:
    session_id: str
    part_id: str
    message_id: str
    old_text: str
    new_text: str
    internal_leak: bool


@dataclass
class MigrationReport:
    scanned_assistant_messages: int = 0
    matched_messages: int = 0
    deleted_messages: int = 0
    sanitized_parts: int = 0
    skipped_malformed_parts: int = 0
    backup_path: str | None = None
    matched_by_session: dict[str, int] = field(default_factory=dict)


def sanitize_text(value: str) -> tuple[str, bool, bool]:
    first_match: int | None = None
    internal_leak = False
    for pattern, is_internal in POLLUTION_PATTERNS:
        match = pattern.search(value)
        if match and (first_match is None or match.start() < first_match):
            first_match = match.start()
            internal_leak = is_internal
    if first_match is None:
        return value, False, False
    return value[:first_match].rstrip(), True, internal_leak


def iter_text_parts(conn: sqlite3.Connection, session_id: str | None = None) -> Iterable[tuple[str, str, str, str]]:
    query = """
        SELECT m.id, m.session_id, p.id, p.data
        FROM message AS m
        JOIN part AS p ON p.message_id = m.id
        WHERE json_extract(m.data, '$.role') = 'assistant'
          AND json_extract(p.data, '$.type') = 'text'
    """
    params: tuple[str, ...] = ()
    if session_id:
        query += " AND m.session_id = ?"
        params = (session_id,)
    query += " ORDER BY m.time_created, p.time_created"
    # Materialize the read-only result so the cursor is finalized before the
    # caller closes the connection (important on Windows).
    return conn.execute(query, params).fetchall()


def collect_changes(conn: sqlite3.Connection, session_id: str | None = None) -> tuple[MigrationReport, list[PartChange], set[str]]:
    report = MigrationReport()
    changes: list[PartChange] = []
    delete_messages: set[str] = set()
    message_texts: dict[str, list[tuple[str, str, bool]]] = {}

    for message_id, sid, part_id, raw_data in iter_text_parts(conn, session_id):
        report.scanned_assistant_messages += 1
        try:
            data = json.loads(raw_data)
            text = data.get("text")
        except (TypeError, json.JSONDecodeError):
            report.skipped_malformed_parts += 1
            continue
        if not isinstance(text, str):
            continue
        new_text, polluted, internal_leak = sanitize_text(text)
        message_texts.setdefault(message_id, []).append((part_id, new_text, polluted and internal_leak))
        if polluted and new_text != text:
            changes.append(PartChange(sid, part_id, message_id, text, new_text, internal_leak))

    for message_id, parts in message_texts.items():
        if any(internal for _, _, internal in parts) and all(not text for _, text, _ in parts):
            delete_messages.add(message_id)

    report.matched_messages = len({change.message_id for change in changes} | delete_messages)
    report.deleted_messages = len(delete_messages)
    report.sanitized_parts = sum(change.message_id not in delete_messages for change in changes)
    for change in changes:
        report.matched_by_session[change.session_id] = report.matched_by_session.get(change.session_id, 0) + 1
    return report, changes, delete_messages


def create_backup(db_path: Path, backup_path: Path | None = None) -> Path:
    if backup_path is None:
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = db_path.with_name(f"{db_path.name}.pollution-backup-{stamp}.sqlite")
    if backup_path.exists():
        raise FileExistsError(f"Backup already exists: {backup_path}")
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(db_path, backup_path)
    return backup_path


def apply_changes(
    db_path: Path,
    changes: list[PartChange],
    delete_messages: set[str],
    fail_after: int | None = None,
) -> None:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    mutation_count = 0
    try:
        conn.execute("BEGIN IMMEDIATE")
        for message_id in delete_messages:
            conn.execute("DELETE FROM part WHERE message_id = ?", (message_id,))
            conn.execute("DELETE FROM message WHERE id = ?", (message_id,))
            mutation_count += 1
            if fail_after is not None and mutation_count >= fail_after:
                raise RuntimeError("injected migration failure")

        for change in changes:
            if change.message_id in delete_messages:
                continue
            row = conn.execute("SELECT data FROM part WHERE id = ?", (change.part_id,)).fetchone()
            if row is None:
                raise RuntimeError(f"Part disappeared during migration: {change.part_id}")
            data = json.loads(row[0])
            data["text"] = change.new_text
            conn.execute("UPDATE part SET data = ?, time_updated = ? WHERE id = ?", (
                json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                int(dt.datetime.now().timestamp() * 1000),
                change.part_id,
            ))
            mutation_count += 1
            if fail_after is not None and mutation_count >= fail_after:
                raise RuntimeError("injected migration failure")

        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError(f"SQLite integrity check failed: {integrity}")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def verify_clean(db_path: Path, session_id: str | None = None) -> int:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        _, changes, delete_messages = collect_changes(conn, session_id)
        remaining = {change.message_id for change in changes} - delete_messages
        if remaining:
            raise RuntimeError(f"Polluted assistant messages remain: {sorted(remaining)}")
        return len(delete_messages)
    finally:
        conn.close()


def migrate(db_path: Path, apply: bool, session_id: str | None = None, backup_path: Path | None = None, fail_after: int | None = None) -> MigrationReport:
    if not db_path.exists():
        raise FileNotFoundError(db_path)
    mode = "ro" if not apply else "rw"
    conn = sqlite3.connect(f"file:{db_path}?mode={mode}", uri=True)
    try:
        report, changes, delete_messages = collect_changes(conn, session_id)
    finally:
        conn.close()

    if not apply:
        return report

    report.backup_path = str(create_backup(db_path, backup_path))
    apply_changes(db_path, changes, delete_messages, fail_after)
    verify_clean(db_path, session_id)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--session-id")
    parser.add_argument("--apply", action="store_true", help="Apply changes; default is a read-only dry-run")
    parser.add_argument("--backup-path", type=Path)
    args = parser.parse_args()

    report = migrate(args.db, args.apply, args.session_id, args.backup_path)
    print(json.dumps({"mode": "apply" if args.apply else "dry-run", **report.__dict__}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
