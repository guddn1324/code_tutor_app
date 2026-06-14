import json
import os
import re
import sqlite3
from datetime import datetime, timedelta

import anthropic
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

load_dotenv()

app = FastAPI()
client = anthropic.Anthropic()

# ── Auth config ───────────────────────────────────────────────

SECRET_KEY = os.getenv("SECRET_KEY", "change-this-in-production")
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "")
ALGORITHM = "HS256"
TOKEN_EXPIRE_DAYS = 30

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer = HTTPBearer()


# ── Database ──────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect("data.db", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            is_approved INTEGER DEFAULT 0,
            is_admin INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            title TEXT,
            code TEXT NOT NULL,
            overall TEXT,
            sections TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS section_explanations (
            session_id TEXT NOT NULL,
            section_index INTEGER NOT NULL,
            explanation TEXT,
            PRIMARY KEY (session_id, section_index),
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
        CREATE TABLE IF NOT EXISTS qa_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );
    """)
    for col in ["is_approved", "is_admin"]:
        try:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} INTEGER DEFAULT 0")
        except Exception:
            pass
    try:
        conn.execute("ALTER TABLE sessions ADD COLUMN merge_groups TEXT")
    except Exception:
        pass
    if ADMIN_EMAIL:
        conn.execute(
            "UPDATE users SET is_admin=1, is_approved=1 WHERE email=?",
            (ADMIN_EMAIL,),
        )
    conn.commit()
    conn.close()


init_db()


# ── Auth helpers ──────────────────────────────────────────────

def make_token(user_id: int) -> str:
    exp = datetime.utcnow() + timedelta(days=TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": str(user_id), "exp": exp}, SECRET_KEY, algorithm=ALGORITHM)


def _decode_token(creds: HTTPAuthorizationCredentials) -> int:
    try:
        payload = jwt.decode(creds.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        return int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=401, detail="로그인이 필요해요")


def current_user(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> int:
    return _decode_token(creds)


def approved_user(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> int:
    user_id = _decode_token(creds)
    conn = get_db()
    try:
        row = conn.execute("SELECT is_approved FROM users WHERE id=?", (user_id,)).fetchone()
    finally:
        conn.close()
    if not row or not row["is_approved"]:
        raise HTTPException(status_code=403, detail="사용 승인이 필요해요. 관리자에게 문의하세요.")
    return user_id


def admin_user(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> int:
    user_id = _decode_token(creds)
    conn = get_db()
    try:
        row = conn.execute("SELECT is_admin FROM users WHERE id=?", (user_id,)).fetchone()
    finally:
        conn.close()
    if not row or not row["is_admin"]:
        raise HTTPException(status_code=403, detail="관리자 권한이 필요해요")
    return user_id


# ── Pydantic models ───────────────────────────────────────────

class AuthRequest(BaseModel):
    email: str
    password: str

MAX_CODE_LEN = 20_000
MAX_QUESTION_LEN = 2_000

class CodeRequest(BaseModel):
    code: str

    def __init__(self, **data):
        super().__init__(**data)
        if len(self.code) > MAX_CODE_LEN:
            raise ValueError("코드가 너무 길어요 (최대 20,000자)")

class SectionRequest(BaseModel):
    code_section: str

class AskRequest(BaseModel):
    code: str
    question: str
    history: list = []

    def __init__(self, **data):
        super().__init__(**data)
        if len(self.question) > MAX_QUESTION_LEN:
            raise ValueError("질문이 너무 길어요 (최대 2,000자)")

class SaveSessionRequest(BaseModel):
    id: str
    title: str
    code: str
    overall: str
    sections: list
    created_at: str

class SaveSectionRequest(BaseModel):
    explanation: str

class QARequest(BaseModel):
    role: str
    content: str


# ── Auth endpoints ────────────────────────────────────────────

@app.post("/auth/register")
def register(req: AuthRequest):
    conn = get_db()
    is_admin = 1 if ADMIN_EMAIL and req.email == ADMIN_EMAIL else 0
    try:
        cur = conn.execute(
            "INSERT INTO users (email, password_hash, is_admin, is_approved) VALUES (?, ?, ?, ?)",
            (req.email, pwd_context.hash(req.password), is_admin, is_admin),
        )
        token = make_token(cur.lastrowid)
        conn.commit()
        return {"token": token, "is_admin": bool(is_admin)}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=400, detail="이미 사용 중인 이메일이에요")
    finally:
        conn.close()


@app.post("/auth/login")
def login(req: AuthRequest):
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (req.email,)).fetchone()
    conn.close()
    if not user or not pwd_context.verify(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="이메일 또는 비밀번호가 틀렸어요")
    return {"token": make_token(user["id"]), "is_admin": bool(user["is_admin"])}


# ── Admin endpoints ───────────────────────────────────────────

@app.get("/admin/users")
def list_users(admin_id: int = Depends(admin_user)):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, email, is_approved, is_admin, created_at FROM users ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return [
        {
            "id": r["id"],
            "email": r["email"],
            "is_approved": bool(r["is_approved"]),
            "is_admin": bool(r["is_admin"]),
            "created_at": r["created_at"],
        }
        for r in rows
    ]


@app.post("/admin/users/{target_id}/approve")
def approve_user(target_id: int, admin_id: int = Depends(admin_user)):
    conn = get_db()
    conn.execute("UPDATE users SET is_approved=1 WHERE id=?", (target_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/admin/users/{target_id}/revoke")
def revoke_user(target_id: int, admin_id: int = Depends(admin_user)):
    conn = get_db()
    conn.execute("UPDATE users SET is_approved=0 WHERE id=?", (target_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/admin/users/{target_id}")
def delete_user(target_id: int, admin_id: int = Depends(admin_user)):
    conn = get_db()
    row = conn.execute("SELECT is_admin FROM users WHERE id=?", (target_id,)).fetchone()
    if not row or row["is_admin"]:
        conn.close()
        raise HTTPException(status_code=403, detail="관리자 계정은 삭제할 수 없습니다")
    conn.execute("DELETE FROM users WHERE id=?", (target_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── Session endpoints ─────────────────────────────────────────

@app.get("/api/sessions")
def list_sessions(user_id: int = Depends(current_user)):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, title, created_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC",
        (user_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/sessions")
def save_session(req: SaveSessionRequest, user_id: int = Depends(current_user)):
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO sessions (id, user_id, title, code, overall, sections, created_at) VALUES (?,?,?,?,?,?,?)",
        (req.id, user_id, req.title, req.code, req.overall, json.dumps(req.sections), req.created_at),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str, user_id: int = Depends(current_user)):
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM sessions WHERE id = ? AND user_id = ?", (session_id, user_id)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="세션을 찾을 수 없어요")
    session = dict(row)
    session["sections"] = json.loads(session["sections"] or "[]")
    mg = session.get("merge_groups")
    session["merge_groups"] = json.loads(mg) if mg else None

    expl_rows = conn.execute(
        "SELECT section_index, explanation FROM section_explanations WHERE session_id = ?",
        (session_id,),
    ).fetchall()
    session["section_explanations"] = {str(r["section_index"]): r["explanation"] for r in expl_rows}

    qa_rows = conn.execute(
        "SELECT role, content FROM qa_messages WHERE session_id = ? ORDER BY id",
        (session_id,),
    ).fetchall()
    session["qa_messages"] = [dict(r) for r in qa_rows]

    conn.close()
    return session


@app.delete("/api/sessions/{session_id}")
def delete_session_api(session_id: str, user_id: int = Depends(current_user)):
    conn = get_db()
    conn.execute("DELETE FROM sessions WHERE id = ? AND user_id = ?", (session_id, user_id))
    conn.execute("DELETE FROM section_explanations WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM qa_messages WHERE session_id = ?", (session_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/sessions/{session_id}/sections/{section_key}")
def save_section_explanation(
    session_id: str, section_key: str, req: SaveSectionRequest,
    user_id: int = Depends(current_user)
):
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO section_explanations (session_id, section_index, explanation) VALUES (?,?,?)",
        (session_id, section_key, req.explanation),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/sessions/{session_id}/sections/{section_key}")
def delete_section_explanation(
    session_id: str, section_key: str,
    user_id: int = Depends(current_user)
):
    conn = get_db()
    conn.execute(
        "DELETE FROM section_explanations WHERE session_id=? AND section_index=?",
        (session_id, section_key),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


class MergeGroupsRequest(BaseModel):
    merge_groups: list


@app.post("/api/sessions/{session_id}/merge-groups")
def save_merge_groups(
    session_id: str, req: MergeGroupsRequest,
    user_id: int = Depends(current_user)
):
    conn = get_db()
    conn.execute(
        "UPDATE sessions SET merge_groups=? WHERE id=? AND user_id=?",
        (json.dumps(req.merge_groups), session_id, user_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/sessions/{session_id}/qa")
def save_qa(session_id: str, req: QARequest, user_id: int = Depends(current_user)):
    conn = get_db()
    conn.execute(
        "INSERT INTO qa_messages (session_id, role, content) VALUES (?,?,?)",
        (session_id, req.role, req.content),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


# ── AI prompts ────────────────────────────────────────────────

OVERALL_SYSTEM = """당신은 친절한 코드 선생님입니다. 대상은 코딩을 막 시작한 입문자예요.
이 코드 전체가 무엇을 하는지 간결하게 한국어로 설명하세요.
전문 용어 없이 쉬운 말로 설명하세요.
제목이나 헤딩(예: "코드 설명", "파이썬 코드 설명" 등)을 절대 붙이지 말고 바로 설명 내용으로 시작하세요."""

SECTION_SYSTEM = """당신은 친절한 코드 선생님입니다. 대상은 코딩을 막 시작한 입문자예요.
선택한 코드 섹션을 구체적이고 친절하게 한국어로 설명하세요.
비유나 실생활 예시를 활용하고 전문 용어는 쉬운 말로 풀어 설명하세요.
제목이나 헤딩(예: "코드 설명", "섹션 설명" 등)을 절대 붙이지 말고 바로 설명 내용으로 시작하세요."""

TITLE_SYSTEM = """코드를 보고 내용을 나타내는 짧은 한국어 제목을 딱 한 줄만 반환하세요.
15자 이내로, 다른 설명 없이 제목만 반환하세요.
예시: 버블 정렬 / 파일 읽고 쓰기 / 로그인 API 구현"""

ASK_SYSTEM = """코드에 대한 질문에 한국어로 답하세요. 대상은 AI가 만들어준 코드를 이해하려는 입문자입니다.
전문 용어는 쉬운 말로 풀어 설명하고, 제목 없이 바로 답변으로 시작하세요."""


# ── AI endpoints ──────────────────────────────────────────────

def stream_response(system, content, max_tokens=1024):
    def generate():
        with client.messages.stream(
            model="claude-haiku-4-5-20251001",
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": content}],
        ) as stream:
            for text in stream.text_stream:
                yield f"data: {json.dumps({'text': text})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/sections")
def sections(req: CodeRequest, user_id: int = Depends(approved_user)):
    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=8192,
            system="코드를 논리적 단위(함수, 클래스, import 블록, 설정 등)로 나눠 JSON 배열로만 반환하세요. 다른 텍스트 없이 JSON만 반환하세요. 원본 코드를 정확히 포함하고 수정하거나 생략하지 마세요.",
            messages=[{"role": "user", "content": f"다음 코드를 논리적 단위로 나눠 JSON 배열로 반환하세요:\n\n```\n{req.code}\n```"}],
        )
        text = response.content[0].text.strip()
        if text.startswith("```"):
            text = re.sub(r"^```[a-z]*\n?", "", text)
            text = re.sub(r"\n?```$", "", text.strip())
        result = json.loads(text)
        if isinstance(result, list) and all(isinstance(s, str) for s in result) and result:
            return {"sections": result}
    except Exception:
        pass

    # fallback: blank-line splitting
    lines = req.code.splitlines()
    result, current = [], []
    for line in lines:
        if line.strip() == "":
            if current:
                result.append("\n".join(current))
                current = []
        else:
            current.append(line)
    if current:
        result.append("\n".join(current))
    return {"sections": result or [req.code]}


@app.post("/explain")
def explain(req: CodeRequest, user_id: int = Depends(approved_user)):
    return stream_response(
        OVERALL_SYSTEM,
        f"다음 코드를 설명해주세요:\n\n```\n{req.code}\n```",
        max_tokens=2048,
    )


@app.post("/explain-section")
def explain_section(req: SectionRequest, user_id: int = Depends(approved_user)):
    return stream_response(
        SECTION_SYSTEM,
        f"다음 코드 섹션을 설명해주세요:\n\n```\n{req.code_section}\n```",
        max_tokens=2048,
    )


@app.post("/title")
def title(req: CodeRequest, user_id: int = Depends(approved_user)):
    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=30,
        system=TITLE_SYSTEM,
        messages=[{"role": "user", "content": f"```\n{req.code}\n```"}],
    )
    return {"title": response.content[0].text.strip()}


@app.post("/ask")
def ask(req: AskRequest, user_id: int = Depends(approved_user)):
    system = f"{ASK_SYSTEM}\n\n분석 중인 코드:\n```\n{req.code}\n```"
    messages = req.history + [{"role": "user", "content": req.question}]

    def generate():
        with client.messages.stream(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            system=system,
            messages=messages,
        ) as stream:
            for text in stream.text_stream:
                yield f"data: {json.dumps({'text': text})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


app.mount("/", StaticFiles(directory="static", html=True), name="static")
