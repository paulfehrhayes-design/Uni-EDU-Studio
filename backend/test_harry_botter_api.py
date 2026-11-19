import sqlite3
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import harry_botter_api
import g1_robot
import server


class HarryBotterAPITests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "classroom.db"
        self.database_patch = patch.object(server, "DB_PATH", str(self.database_path))
        self.database_patch.start()
        server.init_db()
        conn = server.get_db_connection()
        conn.executemany(
            "INSERT OR REPLACE INTO users (username, password, role) VALUES (?, ?, ?)",
            (
                ("ai-teacher", "not-a-real-password", "teacher"),
                ("ai-student", "not-a-real-password", "student"),
                ("ai-other-teacher", "not-a-real-password", "teacher"),
            ),
        )
        conn.commit()
        conn.close()
        self.token_patch = patch.dict(
            server.SESSION_TOKENS,
            {
                "ai-teacher-token": "ai-teacher",
                "ai-student-token": "ai-student",
                "ai-other-teacher-token": "ai-other-teacher",
            },
        )
        self.token_patch.start()
        self.addCleanup(self.token_patch.stop)
        self.client = TestClient(server.app)
        self.teacher_headers = {"Authorization": "Bearer ai-teacher-token"}

    def tearDown(self):
        self.database_patch.stop()
        self.temp_dir.cleanup()

    @staticmethod
    def agent_payload(**overrides):
        return {
            "display_name": "Debate helper",
            "purpose": "Help compare claims and evidence.",
            "instructions": "Ask for evidence and represent viewpoints fairly.",
            "generation_temperature": 0.4,
            "generation_max_tokens": 400,
            **overrides,
        }

    @staticmethod
    def knowledge_payload(**overrides):
        return {
            "filename": "lesson.txt",
            "title": "Evaporation lesson",
            "source": "Teacher-approved class handout",
            "owner": "Science department",
            "intended_use": "Clarify the PYP-to-MYP transition for teacher-reviewed science explanations.",
            "section_id": "curriculum",
            "learning_level": "MYP 3",
            "agent_id": "debate",
            "review_date": (date.today() + timedelta(days=30)).isoformat(),
            "text": "Evaporation is the change from liquid water into water vapour.",
            "permission_confirmed": True,
            **overrides,
        }

    def test_configuration_is_teacher_only_and_builtins_are_seeded(self):
        response = self.client.get("/api/harry-botter/config")
        self.assertEqual(response.status_code, 401)

        response = self.client.get(
            "/api/harry-botter/config",
            headers={"Authorization": "Bearer ai-student-token"},
        )
        self.assertEqual(response.status_code, 403)

        response = self.client.get("/api/harry-botter/config", headers=self.teacher_headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            {agent["agent_id"] for agent in response.json()["agents"]},
            {"general", "debate", "debate_partner"},
        )
        self.assertIn("persona", {
            section["section_id"] for section in response.json()["sections"]
        })

    def test_debate_agent_is_detailed_and_persistent(self):
        response = self.client.get(
            "/api/harry-botter/config",
            headers=self.teacher_headers,
        )
        debate = next(
            agent for agent in response.json()["agents"]
            if agent["agent_id"] == "debate"
        )
        self.assertIn("claims", debate["purpose"].casefold())
        self.assertIn("key question", debate["instructions"].casefold())
        self.assertIn("counterarguments", debate["instructions"].casefold())
        self.assertIn("Early Years", debate["instructions"])
        self.assertIn("DP", debate["instructions"])
        self.assertGreater(len(debate["instructions"]), 2_000)

        other_teacher = self.client.get(
            "/api/harry-botter/config",
            headers={"Authorization": "Bearer ai-other-teacher-token"},
        ).json()
        shared = next(
            agent for agent in other_teacher["agents"]
            if agent["agent_id"] == "debate"
        )
        self.assertEqual(shared["instructions"], debate["instructions"])

    def test_debate_partner_is_a_distinct_persistent_argumentative_agent(self):
        response = self.client.get(
            "/api/harry-botter/config",
            headers=self.teacher_headers,
        )
        agents = {agent["agent_id"]: agent for agent in response.json()["agents"]}
        self.assertIn("debate_partner", agents)
        partner = agents["debate_partner"]
        self.assertIn("debate constructively", partner["purpose"].casefold())
        self.assertIn("acknowledge the student's strongest point", partner["instructions"].casefold())
        self.assertIn("never attack", partner["instructions"].casefold())
        self.assertIn("Early Years", partner["instructions"])
        self.assertIn("approved database sources", partner["instructions"].casefold())
        self.assertGreater(len(partner["instructions"]), 2_000)

    def test_database_sections_and_cais_context_are_substantial(self):
        response = self.client.get(
            "/api/harry-botter/config",
            headers=self.teacher_headers,
        )
        sections = {
            section["section_id"]: section
            for section in response.json()["sections"]
        }
        self.assertEqual(set(sections), {
            "persona",
            "role",
            "curriculum",
            "learner_support",
            "safeguarding",
            "information_use",
            "school_context",
            "voice_personality",
        })
        for section_id, section in sections.items():
            self.assertGreater(
                len(section["guidance"]),
                800,
                f"{section_id} should contain detailed integrated guidance",
            )

        cais_documents = [
            document for document in response.json()["knowledge"]
            if document["section_id"] == "school_context"
        ]
        self.assertGreaterEqual(len(cais_documents), 3)
        combined = "\n".join(document["source"] for document in cais_documents)
        self.assertIn("caischina.org", combined)

    def test_agent_voice_settings_are_auditionable_and_shared(self):
        status = httpx.Response(
            200,
            json={
                "speech_generation": {
                    "available_voices": ["af_heart", "af_bella"],
                }
            },
        )
        with patch.object(harry_botter_api, "_voice_request", return_value=status):
            saved = self.client.put(
                "/api/harry-botter/agents/general/voice-settings",
                headers=self.teacher_headers,
                json={"voice": "af_bella", "speed": 1.15},
            )
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["agent"]["tts_voice"], "af_bella")
        self.assertEqual(saved.json()["agent"]["tts_speed"], 1.15)

        other_teacher = self.client.get(
            "/api/harry-botter/config",
            headers={"Authorization": "Bearer ai-other-teacher-token"},
        ).json()
        general = next(agent for agent in other_teacher["agents"] if agent["agent_id"] == "general")
        self.assertEqual(general["tts_voice"], "af_bella")

        with patch.object(harry_botter_api, "_voice_request", return_value=status):
            unavailable = self.client.put(
                "/api/harry-botter/agents/general/voice-settings",
                headers=self.teacher_headers,
                json={"voice": "not-installed", "speed": 1.0},
            )
        self.assertEqual(unavailable.status_code, 400)

    def test_behavior_sections_are_shared_and_require_approval_when_appropriate(self):
        updated = self.client.put(
            "/api/harry-botter/sections/persona",
            headers=self.teacher_headers,
            json={"guidance": "Use a calm, curious robot voice."},
        )
        self.assertEqual(updated.status_code, 200)

        other_headers = {"Authorization": "Bearer ai-other-teacher-token"}
        visible = self.client.get(
            "/api/harry-botter/config",
            headers=other_headers,
        ).json()
        persona = next(
            section for section in visible["sections"]
            if section["section_id"] == "persona"
        )
        self.assertEqual(persona["guidance"], "Use a calm, curious robot voice.")

        unapproved = self.client.put(
            "/api/harry-botter/sections/safeguarding",
            headers=self.teacher_headers,
            json={"guidance": "Follow the school escalation procedure."},
        )
        self.assertEqual(unapproved.status_code, 400)

        approved = self.client.put(
            "/api/harry-botter/sections/safeguarding",
            headers=self.teacher_headers,
            json={
                "guidance": "Follow the approved school escalation procedure.",
                "approval_confirmed": True,
            },
        )
        self.assertEqual(approved.status_code, 200)

        student = self.client.put(
            "/api/harry-botter/sections/persona",
            headers={"Authorization": "Bearer ai-student-token"},
            json={"guidance": "Change the persona."},
        )
        self.assertEqual(student.status_code, 403)

    def test_existing_knowledge_schema_is_migrated_with_general_section(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            CREATE TABLE harry_botter_knowledge (
                document_id TEXT PRIMARY KEY, filename TEXT NOT NULL,
                title TEXT NOT NULL, source TEXT NOT NULL, owner TEXT NOT NULL,
                learning_level TEXT NOT NULL DEFAULT '', agent_id TEXT NOT NULL DEFAULT '',
                review_date TEXT, text TEXT NOT NULL, digest TEXT NOT NULL,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO harry_botter_knowledge
                (document_id, filename, title, source, owner, text, digest, created_at, updated_at)
            VALUES ('legacy', 'old.txt', 'Old', 'Old source', 'Owner', 'Text', 'digest', 'now', 'now')
            """
        )

        harry_botter_api.initialize_harry_botter_schema(conn)

        row = conn.execute(
            """
            SELECT section_id, version, permission_confirmed_at
            FROM harry_botter_knowledge WHERE document_id = 'legacy'
            """
        ).fetchone()
        self.assertEqual(row["section_id"], "general")
        self.assertEqual(row["version"], 1)
        self.assertEqual(row["permission_confirmed_at"], "now")
        conn.close()

    def test_agent_and_knowledge_changes_are_shared_across_teacher_accounts(self):
        created = self.client.post(
            "/api/harry-botter/agents",
            headers=self.teacher_headers,
            json=self.agent_payload(),
        )
        self.assertEqual(created.status_code, 201)
        agent = created.json()["agent"]
        self.assertTrue(agent["agent_id"].startswith("custom-"))
        self.assertFalse(agent["is_builtin"])

        other_headers = {"Authorization": "Bearer ai-other-teacher-token"}
        visible = self.client.get("/api/harry-botter/config", headers=other_headers).json()
        self.assertIn(agent["agent_id"], {item["agent_id"] for item in visible["agents"]})

        missing_permission = self.client.post(
            "/api/harry-botter/knowledge",
            headers=self.teacher_headers,
            json=self.knowledge_payload(permission_confirmed=False),
        )
        self.assertEqual(missing_permission.status_code, 400)

        uploaded = self.client.post(
            "/api/harry-botter/knowledge",
            headers=self.teacher_headers,
            json=self.knowledge_payload(agent_id=agent["agent_id"]),
        )
        self.assertEqual(uploaded.status_code, 201)
        document = uploaded.json()["document"]
        self.assertEqual(len(document["digest"]), 64)
        self.assertEqual(document["text"], self.knowledge_payload(agent_id=agent["agent_id"])["text"])
        self.assertEqual(document["version"], 1)
        self.assertTrue(document["permission_confirmed"])
        self.assertTrue(document["permission_confirmed_at"])
        self.assertIn("PYP-to-MYP transition", document["intended_use"])

        listed = self.client.get("/api/harry-botter/config", headers=other_headers).json()
        listed_document = next(
            item for item in listed["knowledge"]
            if item["document_id"] == document["document_id"]
        )
        self.assertNotIn("text", listed_document)

        updated_payload = self.knowledge_payload(
            agent_id=agent["agent_id"],
            text="Evaporation changes liquid water into water vapour.",
        )
        updated = self.client.put(
            f"/api/harry-botter/knowledge/{document['document_id']}",
            headers=self.teacher_headers,
            json=updated_payload,
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["document"]["version"], 2)
        self.assertNotEqual(updated.json()["document"]["digest"], document["digest"])
        self.assertTrue(updated.json()["document"]["permission_confirmed_at"])
        listed_after_update = self.client.get(
            "/api/harry-botter/config",
            headers=other_headers,
        ).json()
        self.assertEqual(listed_after_update["knowledge"][0]["version"], 2)

    def test_teacher_sessions_persist_text_are_owner_only_and_can_be_deleted(self):
        created = self.client.post(
            "/api/harry-botter/sessions",
            headers=self.teacher_headers,
        )
        self.assertEqual(created.status_code, 201)
        session = created.json()["session"]
        session_id = session["session_id"]

        updated = self.client.put(
            f"/api/harry-botter/sessions/{session_id}/messages",
            headers=self.teacher_headers,
            json={
                "messages": [
                    {
                        "messageId": "turn-1",
                        "role": "user",
                        "content": "Explain evaporation.",
                        "settings": {
                            "learningLevel": "MYP 3",
                            "tone": "Formal",
                            "agentName": "General assistant",
                            "agentId": "general",
                        },
                    },
                    {
                        "messageId": "draft-1",
                        "role": "assistant",
                        "content": "Water changes from liquid to vapour.",
                        "model": "configured-local-model",
                        "route": "local",
                        "source": "local_model",
                        "sources": [
                            {
                                "title": "Water cycle",
                                "source": "Teacher handout",
                                "section_id": "curriculum",
                                "section_title": "Curriculum",
                                "review_date": "2026-11-19",
                            }
                        ],
                        "settings": {
                            "learningLevel": "MYP 3",
                            "tone": "Formal",
                            "agentName": "General assistant",
                            "agentId": "general",
                        },
                        "transcriptToDraftMs": 1420,
                    },
                ]
            },
        )
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["session"]["title"], "Explain evaporation.")

        restored = self.client.get(
            f"/api/harry-botter/sessions/{session_id}",
            headers=self.teacher_headers,
        )
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(len(restored.json()["session"]["messages"]), 2)
        self.assertEqual(
            restored.json()["session"]["messages"][1]["sources"][0]["title"],
            "Water cycle",
        )
        self.assertEqual(
            restored.json()["session"]["settings"],
            {
                "agent_id": "general",
                "learning_level": "MYP 3",
                "tone": "Formal",
                "language": "en",
                "context_policy": "shared",
            },
        )
        draft_id = restored.json()["session"]["messages"][1]["messageId"]
        conn = server.get_db_connection()
        try:
            transcript = conn.execute(
                """
                SELECT source, content, learning_level
                FROM harry_botter_transcript_turns
                WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
            draft = conn.execute(
                """
                SELECT draft_id, based_on_turn_id, model_id, model_route,
                       transcript_to_draft_ms, status
                FROM harry_botter_response_drafts
                WHERE session_id = ?
                """,
                (session_id,),
            ).fetchone()
        finally:
            conn.close()
        self.assertEqual(dict(transcript), {
            "source": "typed",
            "content": "Explain evaporation.",
            "learning_level": "MYP 3",
        })
        self.assertEqual(draft["draft_id"], "draft-1")
        self.assertEqual(draft["model_id"], "configured-local-model")
        self.assertEqual(draft["transcript_to_draft_ms"], 1420)
        self.assertEqual(draft["status"], "draft")

        played = self.client.post(
            f"/api/harry-botter/sessions/{session_id}/playback-events",
            headers=self.teacher_headers,
            json={
                "draft_id": draft_id,
                "voice_id": "af_bella",
                "speed": 1.15,
                "duration_ms": 1800,
            },
        )
        self.assertEqual(played.status_code, 201)
        self.assertEqual(played.json()["playback"]["status"], "completed")
        self.assertEqual(played.json()["playback"]["voice_id"], "af_bella")

        other_teacher = self.client.get(
            f"/api/harry-botter/sessions/{session_id}",
            headers={"Authorization": "Bearer ai-other-teacher-token"},
        )
        self.assertEqual(other_teacher.status_code, 404)
        student = self.client.get(
            "/api/harry-botter/sessions",
            headers={"Authorization": "Bearer ai-student-token"},
        )
        self.assertEqual(student.status_code, 403)

        listed = self.client.get(
            "/api/harry-botter/sessions",
            headers=self.teacher_headers,
        )
        self.assertEqual([item["session_id"] for item in listed.json()["sessions"]], [session_id])
        deleted = self.client.delete(
            f"/api/harry-botter/sessions/{session_id}",
            headers=self.teacher_headers,
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(
            self.client.get(
                f"/api/harry-botter/sessions/{session_id}",
                headers=self.teacher_headers,
            ).status_code,
            404,
        )

    def test_legacy_conversation_json_is_backfilled_into_explicit_records(self):
        created = self.client.post(
            "/api/harry-botter/sessions",
            headers=self.teacher_headers,
        )
        session_id = created.json()["session"]["session_id"]
        conn = server.get_db_connection()
        conn.execute(
            """
            INSERT INTO harry_botter_session_messages
                (session_id, position, message_json)
            VALUES (?, 0, ?), (?, 1, ?)
            """,
            (
                session_id,
                '{"role":"user","content":"A saved question."}',
                session_id,
                '{"role":"assistant","content":"A saved draft.","model":"qwen3:0.6b","route":"local"}',
            ),
        )
        harry_botter_api.initialize_harry_botter_schema(conn)
        turns = conn.execute(
            "SELECT content, source FROM harry_botter_transcript_turns WHERE session_id = ?",
            (session_id,),
        ).fetchall()
        drafts = conn.execute(
            "SELECT content, model_id FROM harry_botter_response_drafts WHERE session_id = ?",
            (session_id,),
        ).fetchall()
        conn.close()
        self.assertEqual([dict(row) for row in turns], [{
            "content": "A saved question.",
            "source": "typed",
        }])
        self.assertEqual([dict(row) for row in drafts], [{
            "content": "A saved draft.",
            "model_id": "qwen3:0.6b",
        }])

    def test_safeguarding_signal_creates_owner_only_advisory_alert(self):
        created = self.client.post(
            "/api/harry-botter/sessions",
            headers=self.teacher_headers,
        )
        session_id = created.json()["session"]["session_id"]

        def fake_voice_request(method, path, *, json_payload=None, **_):
            return httpx.Response(
                200,
                json={
                    "draft": {
                        "text": "Please speak to a trusted adult nearby.",
                        "source": "local_model",
                        "model": "configured-local-model",
                        "route": "local",
                        "sources": [],
                    }
                },
            )

        with patch.object(harry_botter_api, "_voice_request", side_effect=fake_voice_request):
            response = self.client.post(
                "/api/harry-botter/draft",
                headers=self.teacher_headers,
                json={
                    "text": "I want to kill myself tonight.",
                    "session_id": session_id,
                    "agent_id": "general",
                    "history": [],
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["safeguarding_alerts"][0]["category"],
            "possible_self_harm",
        )
        alerts = self.client.get(
            "/api/harry-botter/alerts",
            headers=self.teacher_headers,
        ).json()["alerts"]
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["session_id"], session_id)
        self.assertEqual(alerts[0]["session_title"], "New conversation")
        self.assertEqual(alerts[0]["detector_version"], "phrase-patterns-v1")

        other_teacher_alerts = self.client.get(
            "/api/harry-botter/alerts",
            headers={"Authorization": "Bearer ai-other-teacher-token"},
        ).json()["alerts"]
        self.assertEqual(other_teacher_alerts, [])
        student_alerts = self.client.get(
            "/api/harry-botter/alerts",
            headers={"Authorization": "Bearer ai-student-token"},
        )
        self.assertEqual(student_alerts.status_code, 403)

        acknowledged = self.client.post(
            f"/api/harry-botter/alerts/{alerts[0]['alert_id']}/acknowledge",
            headers=self.teacher_headers,
        )
        self.assertEqual(acknowledged.status_code, 200)
        self.assertEqual(
            self.client.get(
                "/api/harry-botter/alerts",
                headers=self.teacher_headers,
            ).json()["alerts"],
            [],
        )

    def test_policy_review_uses_only_approved_in_scope_current_references(self):
        created = self.client.post(
            "/api/harry-botter/knowledge",
            headers=self.teacher_headers,
            json=self.knowledge_payload(),
        )
        self.assertEqual(created.status_code, 201)
        document_id = created.json()["document"]["document_id"]
        captured = {}
        proposal = {
            "proposed_guidance": "Use the supplied school procedure.",
            "source_notes": ["[R1] supports this proposal."],
            "conflicts": [],
            "open_questions": ["Confirm stage applicability."],
        }

        def fake_voice_request(method, path, *, json_payload=None, **_):
            captured.update({"method": method, "path": path, "payload": json_payload})
            return httpx.Response(
                200,
                json={
                    "proposal": proposal,
                    "model": "configured-local-model",
                    "route": "local",
                    "sources": [{
                        "reference_id": document_id,
                        "title": "[R1] Evaporation lesson",
                        "source": "Teacher-approved class handout",
                        "owner": "Science department",
                        "review_date": self.knowledge_payload()["review_date"],
                    }],
                },
            )

        with patch.object(harry_botter_api, "_voice_request", side_effect=fake_voice_request):
            response = self.client.post(
                "/api/harry-botter/policy-review",
                headers=self.teacher_headers,
                json={
                    "section_id": "curriculum",
                    "document_ids": [document_id],
                    "current_guidance": "Unsaved teacher editor draft.",
                    "learning_level": "MYP 3",
                    "agent_id": "debate",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["proposal"], proposal)
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["path"], "/api/v1/policy-review")
        self.assertEqual(
            captured["payload"]["current_guidance"],
            "Unsaved teacher editor draft.",
        )
        self.assertEqual(captured["payload"]["sources"][0]["reference_id"], document_id)
        self.assertTrue(captured["payload"]["sources"][0]["title"].startswith("[R1]"))
        self.assertIn("Evaporation", captured["payload"]["sources"][0]["excerpt"])

    def test_policy_review_rejects_expired_or_out_of_scope_references(self):
        expired = self.client.post(
            "/api/harry-botter/knowledge",
            headers=self.teacher_headers,
            json=self.knowledge_payload(
                review_date=(date.today() - timedelta(days=1)).isoformat(),
            ),
        ).json()["document"]["document_id"]
        out_of_scope = self.client.post(
            "/api/harry-botter/knowledge",
            headers=self.teacher_headers,
            json=self.knowledge_payload(
                title="Other section",
                section_id="persona",
            ),
        ).json()["document"]["document_id"]
        stage_scoped = self.client.post(
            "/api/harry-botter/knowledge",
            headers=self.teacher_headers,
            json=self.knowledge_payload(learning_level="PYP 2"),
        ).json()["document"]["document_id"]

        expired_response = self.client.post(
            "/api/harry-botter/policy-review",
            headers=self.teacher_headers,
            json={
                "section_id": "curriculum",
                "document_ids": [expired],
                "current_guidance": "Current guidance.",
                "learning_level": "MYP 3",
                "agent_id": "debate",
            },
        )
        scope_response = self.client.post(
            "/api/harry-botter/policy-review",
            headers=self.teacher_headers,
            json={
                "section_id": "curriculum",
                "document_ids": [out_of_scope],
                "current_guidance": "Current guidance.",
                "learning_level": "MYP 3",
                "agent_id": "debate",
            },
        )
        unspecified_stage_response = self.client.post(
            "/api/harry-botter/policy-review",
            headers=self.teacher_headers,
            json={
                "section_id": "curriculum",
                "document_ids": [stage_scoped],
                "current_guidance": "Current guidance.",
                "agent_id": "debate",
            },
        )
        student_response = self.client.post(
            "/api/harry-botter/policy-review",
            headers={"Authorization": "Bearer ai-student-token"},
            json={
                "section_id": "curriculum",
                "document_ids": [expired],
                "current_guidance": "Current guidance.",
                "learning_level": "MYP 3",
                "agent_id": "debate",
            },
        )

        self.assertEqual(expired_response.status_code, 409)
        self.assertEqual(scope_response.status_code, 400)
        self.assertEqual(unspecified_stage_response.status_code, 400)
        self.assertEqual(student_response.status_code, 403)

    def test_speech_proxy_forwards_curated_voice_and_pace(self):
        captured = {}

        def fake_voice_request(method, path, *, json_payload=None, **_):
            captured.update({"method": method, "path": path, "payload": json_payload})
            return httpx.Response(
                200,
                headers={"content-type": "audio/wav"},
                content=b"RIFF-test-wave",
            )

        with patch.object(harry_botter_api, "_voice_request", side_effect=fake_voice_request):
            for voice in ("af_heart", "qwen3_youthful_south_london"):
                with self.subTest(voice=voice):
                    captured.clear()
                    response = self.client.post(
                        "/api/harry-botter/speech",
                        headers=self.teacher_headers,
                        json={
                            "text": "A test response.",
                            "speed": 1.15,
                            "voice": voice,
                        },
                    )

                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.content, b"RIFF-test-wave")
                    self.assertEqual(captured["path"], "/api/v1/speech")
                    self.assertEqual(
                        captured["payload"],
                        {"text": "A test response.", "speed": 1.15, "voice": voice},
                    )

    def test_model_selection_proxy_forwards_teacher_choice(self):
        captured = {}

        def fake_voice_request(method, path, *, json_payload=None, **_):
            captured.update({"method": method, "path": path, "payload": json_payload})
            return httpx.Response(200, json={"status": "ready", "route": "local", "model": "qwen3:1.7b"})

        with patch.object(harry_botter_api, "_voice_request", side_effect=fake_voice_request):
            response = self.client.post(
                "/api/harry-botter/model-select",
                headers=self.teacher_headers,
                json={"route": "local", "model": "qwen3:1.7b"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(captured["path"], "/api/v1/model/select")
        self.assertEqual(captured["payload"], {"route": "local", "model": "qwen3:1.7b"})

    def test_model_status_proxy_uses_bounded_timeout(self):
        captured = {}

        def fake_voice_request(method, path, **kwargs):
            captured.update({"method": method, "path": path, **kwargs})
            return httpx.Response(200, json={"status": "ready", "model": "qwen3:0.6b"})

        with patch.object(harry_botter_api, "_voice_request", side_effect=fake_voice_request):
            response = self.client.get(
                "/api/harry-botter/model-status",
                headers=self.teacher_headers,
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(captured["method"], "GET")
        self.assertEqual(captured["path"], "/api/v1/model/status")
        self.assertEqual(captured["timeout_seconds"], 8)

    def test_draft_proxy_sends_only_matching_current_knowledge(self):
        self.client.put(
            "/api/harry-botter/sections/persona",
            headers=self.teacher_headers,
            json={"guidance": "Use a calm, curious robot voice."},
        )
        selected = self.client.post(
            "/api/harry-botter/knowledge",
            headers=self.teacher_headers,
            json=self.knowledge_payload(),
        )
        self.assertEqual(selected.status_code, 201)
        self.assertEqual(selected.json()["document"]["section_id"], "curriculum")
        self.client.post(
            "/api/harry-botter/knowledge",
            headers=self.teacher_headers,
            json=self.knowledge_payload(
                title="Unrelated stage reference",
                learning_level="DP 1",
                text="A reference about a different subject.",
            ),
        )
        self.client.post(
            "/api/harry-botter/knowledge",
            headers=self.teacher_headers,
            json=self.knowledge_payload(
                title="Expired reference",
                review_date=(date.today() - timedelta(days=1)).isoformat(),
                text="Evaporation water liquid old reference.",
            ),
        )
        captured = {}

        def fake_voice_request(method, path, *, json_payload=None, **_):
            captured.update({"method": method, "path": path, "payload": json_payload})
            return httpx.Response(
                200,
                json={
                    "draft": {
                        "text": "Water can evaporate.",
                        "source": "local_model",
                        "model": "configured-local-model",
                        "route": "local",
                        "sources": [
                            {
                                "title": "Evaporation lesson",
                                "source": "Teacher-approved class handout",
                                "review_date": self.knowledge_payload()["review_date"],
                            }
                        ],
                    }
                },
            )

        with patch.object(harry_botter_api, "_voice_request", side_effect=fake_voice_request):
            response = self.client.post(
                "/api/harry-botter/draft",
                headers=self.teacher_headers,
                json={
                    "text": "Explain evaporation.",
                    "learning_level": "MYP 3",
                    "tone": "Formal",
                    "agent_id": "debate",
                    "history": [],
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["draft"]["route"], "local")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["path"], "/api/v1/drafts")
        self.assertNotIn("knowledge", captured["payload"])
        self.assertNotIn("sections", captured["payload"])
        self.assertEqual(captured["payload"]["agent"]["agent_id"], "debate")

    def test_g1_speech_requires_teacher_and_uses_existing_audio_client(self):
        class FakeAudioClient:
            def __init__(self):
                self.calls = []

            def TtsMaker(self, text, speaker_id):
                self.calls.append((text, speaker_id))
                return 0

        original_audio_client = g1_robot._audio_client
        audio_client = FakeAudioClient()
        g1_robot._audio_client = audio_client
        self.addCleanup(setattr, g1_robot, "_audio_client", original_audio_client)

        student = self.client.post(
            "/api/harry-botter/g1-speak",
            headers={"Authorization": "Bearer ai-student-token"},
            json={"text": "A generated draft.", "speaker_id": 0},
        )
        self.assertEqual(student.status_code, 403)

        response = self.client.post(
            "/api/harry-botter/g1-speak",
            headers=self.teacher_headers,
            json={"text": "A generated draft.", "speaker_id": 0},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "accepted"})
        self.assertEqual(audio_client.calls, [("A generated draft.", 0)])

        too_long = self.client.post(
            "/api/harry-botter/g1-speak",
            headers=self.teacher_headers,
            json={"text": "x" * 121, "speaker_id": 0},
        )
        self.assertEqual(too_long.status_code, 422)

    def test_audio_stream_rejects_missing_and_student_authentication(self):
        cases = (
            ([], 4401),
            (["edu-auth.ai-student-token"], 4403),
        )
        for subprotocols, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                with self.assertRaises(WebSocketDisconnect) as disconnect:
                    with self.client.websocket_connect(
                        "/api/harry-botter/stream",
                        subprotocols=subprotocols,
                    ) as websocket:
                        websocket.receive_json()
                self.assertEqual(disconnect.exception.code, expected_code)


if __name__ == "__main__":
    unittest.main()
