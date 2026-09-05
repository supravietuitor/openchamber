#!/usr/bin/env python3
"""Scan all sessions for likely duplicate assistant messages without modifying the DB."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import sqlite3
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path


DEFAULT_DB = Path(r"D:\AI\Memory\opencode\opencode.db")


@dataclass(frozen=True)
class AssistantMessage:
    message_id: str
    session_id: str
    parent_id: str
    time_created: int
    text: str


def canonical_text(parts: list[tuple[int, str]]) -> str:
    return "\n".join(text.replace("\r\n", "\n").rstrip() for _, text in sorted(parts))


def load_messages(db_path: Path, session_id: str | None = None) -> list[AssistantMessage]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        query = """
            SELECT m.id, m.session_id, m.time_created, m.data, p.time_created, p.data
            FROM message AS m
            JOIN part AS p ON p.message_id = m.id
            WHERE json_extract(m.data, '$.role') = 'assistant'
              AND json_extract(p.data, '$.type') = 'text'
        """
        params: tuple[str, ...] = ()
        if session_id:
            query += " AND m.session_id = ?"
            params = (session_id,)
        query += " ORDER BY m.session_id, m.time_created, p.time_created, p.id"
        grouped: dict[str, tuple[str, str, str, int, list[tuple[int, str]]]] = {}
        for message_id, sid, message_time, raw_message, part_time, raw_part in conn.execute(query, params):
            try:
                message = json.loads(raw_message)
                part = json.loads(raw_part)
                text = part.get("text")
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(text, str):
                continue
            if message_id not in grouped:
                parent_id = message.get("parentID") if isinstance(message, dict) else ""
                grouped[message_id] = (message_id, sid, parent_id if isinstance(parent_id, str) else "", message_time, [])
            grouped[message_id][4].append((part_time, text))
        return [AssistantMessage(mid, sid, parent, created, canonical_text(parts)) for mid, sid, parent, created, parts in grouped.values()]
    finally:
        conn.close()


def scan(messages: list[AssistantMessage], window_seconds: int, similarity_threshold: float) -> dict:
    exact_groups: list[dict] = []
    similar_pairs: list[dict] = []
    by_session_hash: dict[tuple[str, str, str], list[AssistantMessage]] = defaultdict(list)
    for message in messages:
        if not message.text or not message.parent_id:
            continue
        digest = hashlib.sha256(message.text.encode("utf-8")).hexdigest()
        by_session_hash[(message.session_id, message.parent_id, digest)].append(message)

    for (session_id, parent_id, _), group in by_session_hash.items():
        group.sort(key=lambda item: item.time_created)
        current: list[AssistantMessage] = [group[0]]
        for message in group[1:]:
            if (message.time_created - current[-1].time_created) / 1000 <= window_seconds:
                current.append(message)
            else:
                if len(current) > 1:
                    exact_groups.append(group_record(session_id, parent_id, current))
                current = [message]
        if len(current) > 1:
            exact_groups.append(group_record(session_id, parent_id, current))

    by_session: dict[str, list[AssistantMessage]] = defaultdict(list)
    for message in messages:
        if message.text:
            by_session[message.session_id].append(message)
    for session_id, group in by_session.items():
        group.sort(key=lambda item: item.time_created)
        for left, right in zip(group, group[1:]):
            delta = (right.time_created - left.time_created) / 1000
            if delta > window_seconds or left.text == right.text or not left.parent_id or left.parent_id != right.parent_id:
                continue
            ratio = difflib.SequenceMatcher(None, left.text, right.text).ratio()
            if ratio >= similarity_threshold:
                similar_pairs.append({
                    "session_id": session_id,
                    "parent_id": left.parent_id,
                    "left_message_id": left.message_id,
                    "right_message_id": right.message_id,
                    "seconds_apart": round(delta, 3),
                    "similarity": round(ratio, 4),
                })

    return {
        "scanned_assistant_messages": len(messages),
        "high_confidence_groups": exact_groups,
        "high_confidence_candidate_messages": sum(len(group["message_ids"]) - 1 for group in exact_groups),
        "similar_pairs_review_only": similar_pairs,
    }


def group_record(session_id: str, parent_id: str, messages: list[AssistantMessage]) -> dict:
    return {
        "session_id": session_id,
        "parent_id": parent_id,
        "keep_message_id": messages[0].message_id,
        "message_ids": [message.message_id for message in messages],
        "time_created": [message.time_created for message in messages],
        "text_sha256": hashlib.sha256(messages[0].text.encode("utf-8")).hexdigest(),
        "text_preview": messages[0].text[:240],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--session-id")
    parser.add_argument("--window-seconds", type=int, default=600)
    parser.add_argument("--similarity-threshold", type=float, default=0.92)
    args = parser.parse_args()
    messages = load_messages(args.db, args.session_id)
    print(json.dumps(scan(messages, args.window_seconds, args.similarity_threshold), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
