"""In-memory session lifecycle for the initial local service API."""

from dataclasses import dataclass, replace
from datetime import datetime, timezone
from enum import Enum
from threading import RLock
from uuid import uuid4


class SessionState(str, Enum):
    CREATED = "created"
    RUNNING = "running"
    STOPPED = "stopped"


class SessionNotFoundError(LookupError):
    """Raised when a requested session does not exist."""


class InvalidSessionTransitionError(ValueError):
    """Raised when a session lifecycle operation is not valid."""


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class VoiceSession:
    session_id: str
    state: SessionState
    created_at: str
    updated_at: str
    started_at: str | None = None
    stopped_at: str | None = None

    def to_dict(self) -> dict[str, str | None]:
        return {
            "session_id": self.session_id,
            "state": self.state.value,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "started_at": self.started_at,
            "stopped_at": self.stopped_at,
        }


class SessionManager:
    """Thread-safe, process-local session store; it retains no conversation data."""

    def __init__(self) -> None:
        self._sessions: dict[str, VoiceSession] = {}
        self._lock = RLock()

    def create(self) -> VoiceSession:
        now = _timestamp()
        session = VoiceSession(
            session_id=str(uuid4()),
            state=SessionState.CREATED,
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    def get(self, session_id: str) -> VoiceSession:
        with self._lock:
            try:
                return self._sessions[session_id]
            except KeyError as exc:
                raise SessionNotFoundError(session_id) from exc

    def start(self, session_id: str) -> VoiceSession:
        with self._lock:
            session = self._get_locked(session_id)
            if session.state is not SessionState.CREATED:
                raise InvalidSessionTransitionError(
                    f"Cannot start a session in the {session.state.value} state."
                )
            now = _timestamp()
            updated = replace(
                session,
                state=SessionState.RUNNING,
                updated_at=now,
                started_at=now,
            )
            self._sessions[session_id] = updated
            return updated

    def stop(self, session_id: str) -> VoiceSession:
        with self._lock:
            session = self._get_locked(session_id)
            if session.state is not SessionState.RUNNING:
                raise InvalidSessionTransitionError(
                    f"Cannot stop a session in the {session.state.value} state."
                )
            now = _timestamp()
            updated = replace(
                session,
                state=SessionState.STOPPED,
                updated_at=now,
                stopped_at=now,
            )
            self._sessions[session_id] = updated
            return updated

    def delete(self, session_id: str) -> None:
        with self._lock:
            if session_id not in self._sessions:
                raise SessionNotFoundError(session_id)
            del self._sessions[session_id]

    def _get_locked(self, session_id: str) -> VoiceSession:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise SessionNotFoundError(session_id) from exc
