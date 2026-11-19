"""Persistent mirror of educator-managed Harry Botter database context."""

import os
import re
import sqlite3
from datetime import date
from pathlib import Path
import json


class ContextStore:
    def __init__(self, database_path: str | None = None) -> None:
        default_path = Path(__file__).resolve().parents[2] / "context.db"
        self.database_path = Path(
            database_path
            or os.environ.get(
                "HARRY_BOTTER_APP_DB",
                os.environ.get("HARRY_BOTTER_CONTEXT_DB", str(default_path)),
            )
        )
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.database_path), timeout=5)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS agents (
                    agent_id TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sections (
                    section_id TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS documents (
                    document_id TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )

    def replace(self, snapshot: dict) -> None:
        agents = snapshot.get("agents")
        sections = snapshot.get("sections")
        documents = snapshot.get("knowledge")
        if not all(isinstance(item, list) for item in (agents, sections, documents)):
            raise ValueError("Invalid context snapshot.")
        with self._connect() as connection:
            connection.execute("DELETE FROM agents")
            connection.execute("DELETE FROM sections")
            connection.execute("DELETE FROM documents")
            connection.executemany(
                "INSERT INTO agents (agent_id, data_json, updated_at) VALUES (?, ?, ?)",
                [
                    (
                        item["agent_id"],
                        json.dumps(item, ensure_ascii=False),
                        item.get("updated_at", ""),
                    )
                    for item in agents
                    if isinstance(item, dict) and isinstance(item.get("agent_id"), str)
                ],
            )
            connection.executemany(
                "INSERT INTO sections (section_id, data_json, updated_at) VALUES (?, ?, ?)",
                [
                    (
                        item["section_id"],
                        __import__("json").dumps(item, ensure_ascii=False),
                        item.get("updated_at", ""),
                    )
                    for item in sections
                    if isinstance(item, dict) and isinstance(item.get("section_id"), str)
                ],
            )
            connection.executemany(
                "INSERT INTO documents (document_id, data_json, updated_at) VALUES (?, ?, ?)",
                [
                    (
                        item["document_id"],
                        __import__("json").dumps(item, ensure_ascii=False),
                        item.get("updated_at", ""),
                    )
                    for item in documents
                    if isinstance(item, dict) and isinstance(item.get("document_id"), str)
                ],
            )
            connection.execute(
                "INSERT OR REPLACE INTO metadata (key, value) VALUES ('revision', ?)",
                (str(snapshot.get("revision", "")),),
            )

    def revision(self) -> str:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT value FROM metadata WHERE key = 'revision'"
            ).fetchone()
        return row["value"] if row else ""

    def agent(self, agent_id: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT data_json FROM agents WHERE agent_id = ?", (agent_id,)
            ).fetchone()
        return __import__("json").loads(row["data_json"]) if row else None

    def sections(self) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT data_json FROM sections ORDER BY section_id"
            ).fetchall()
        return [__import__("json").loads(row["data_json"]) for row in rows]

    def retrieve(
        self,
        text: str,
        learning_level: str,
        agent_id: str,
        limit: int = 10,
        excerpt_chars: int = 4_000,
    ) -> list[dict]:
        terms = {
            term
            for term in re.findall(r"[a-z0-9]{3,}", text.casefold())
            if term not in {"the", "and", "for", "with", "that", "this", "from", "what", "how"}
        }
        today = date.today().isoformat()
        ranked: list[tuple[int, str, str, dict]] = []
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT data_json FROM documents"
            ).fetchall()
        for row in rows:
            document = __import__("json").loads(row["data_json"])
            if not document.get("permission_confirmed_at"):
                continue
            if document.get("learning_level") and document["learning_level"] != learning_level:
                continue
            if document.get("agent_id") and document["agent_id"] != agent_id:
                continue
            review_date = document.get("review_date")
            if review_date and review_date < today:
                continue
            metadata = " ".join(
                str(document.get(key, ""))
                for key in ("title", "source", "owner", "intended_use", "section_id")
            ).casefold()
            chunks = re.split(r"\n\s*\n+", document.get("text", ""))
            for chunk_index, chunk in enumerate(chunks):
                chunk = " ".join(chunk.split())
                if len(chunk) < 40:
                    continue
                score = sum(metadata.count(term) * 3 for term in terms)
                score += sum(chunk.casefold().count(term) for term in terms)
                if score:
                    ranked.append((score, document["title"].casefold(), str(chunk_index), {
                        "title": document["title"],
                        "source": document["source"],
                        "owner": document["owner"],
                        "intended_use": document["intended_use"],
                        "section_id": document["section_id"],
                        "section_title": document.get("section_title", "General reference"),
                        "review_date": document.get("review_date") or "",
                        "excerpt": chunk[:excerpt_chars],
                    }))
        ranked.sort(key=lambda item: (-item[0], item[1], int(item[2])))
        results = []
        seen: set[tuple[str, str]] = set()
        for _, _, _, result in ranked:
            identity = (result["title"], result["excerpt"])
            if identity in seen:
                continue
            seen.add(identity)
            results.append(result)
            if len(results) >= limit:
                break
        return results
