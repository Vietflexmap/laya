"""FastAPI middleware for BILAtiny Chat.

Design:
Unicode Vietnamese -> CVNSS4.0 representation in the browser -> Laya decision gate
-> DeepSeek -> final Unicode Vietnamese (NFC).

The server never returns DeepSeek reasoning_content. It only returns the final answer and
small decision metadata. This keeps the UI focused on results rather than private chain-of-thought.
"""
from __future__ import annotations

import os
import time
import unicodedata
from functools import lru_cache
from typing import Any, Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
DEFAULT_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")
LAYA_ENABLED = os.getenv("LAYA_ENABLED", "1").strip().lower() not in {"0", "false", "no", "off"}
LAYA_PRELOAD = os.getenv("LAYA_PRELOAD", "0").strip().lower() in {"1", "true", "yes", "on"}
LAYA_THRESHOLD = float(os.getenv("LAYA_CONFIDENCE_THRESHOLD", "0.78"))
REQUEST_TIMEOUT = float(os.getenv("DEEPSEEK_TIMEOUT_SECONDS", "120"))

_ALLOWED_DEFAULT = "http://127.0.0.1:5500,http://localhost:5500,https://vietflexmap.github.io"
ALLOWED_ORIGINS = [x.strip() for x in os.getenv("ALLOWED_ORIGINS", _ALLOWED_DEFAULT).split(",") if x.strip()]

app = FastAPI(title="BILAtiny Decision Middleware", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-DeepSeek-Key"],
)


class HistoryItem(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    message_unicode: str = Field(min_length=1, max_length=50_000)
    message_cvnss: str = Field(min_length=1, max_length=50_000)
    history: list[HistoryItem] = Field(default_factory=list, max_length=20)
    model: str | None = None
    force_thinking: bool = False


@lru_cache(maxsize=1)
def get_laya_router():
    """Lazy-load only the multilingual checkpoint used for Vietnamese traffic."""
    if not LAYA_ENABLED:
        return None
    from laya import Router

    router = Router(default="multilingual", max_loaded=1)
    if LAYA_PRELOAD:
        router.preload(["multilingual"])
    return router


LAYA_QUESTIONS: dict[str, Any] = {
    "mode": {
        "type": "choice",
        "instructions": "Choose the cheapest safe processing mode for this user request.",
        "criteria": {
            "fast": "simple chat, lookup-style explanation, short rewrite or direct factual response",
            "think": "multi-step reasoning, planning, complex analysis, ambiguity or high consequence",
            "code": "software engineering, debugging, architecture, implementation or code review",
        },
    },
    "needs_thinking": {
        "type": "noul",
        "instructions": "Would deeper multi-step reasoning materially improve the answer?",
    },
}


def heuristic_decision(text: str) -> dict[str, Any]:
    """Conservative fallback when Laya is disabled/unavailable."""
    low = text.lower()
    code_terms = ("code", "python", "javascript", "rust", "api", "github", "bug", "lỗi", "kiến trúc")
    deep_terms = ("phân tích", "so sánh", "thiết kế", "tối ưu", "chiến lược", "vì sao", "kế hoạch")
    if any(t in low for t in code_terms):
        mode = "code"
    elif len(text) > 900 or any(t in low for t in deep_terms):
        mode = "think"
    else:
        mode = "fast"
    return {"mode": mode, "confidence": 0.0, "source": "heuristic", "thinking": mode != "fast"}


def laya_decision(unicode_text: str, cvnss_text: str) -> dict[str, Any]:
    if not LAYA_ENABLED:
        return heuristic_decision(unicode_text)
    try:
        from laya import router_questions

        router = get_laya_router()
        state = {
            "request": unicode_text,
            "cvnss4": cvnss_text,
            "language": "vi",
        }
        result = router.predict(state, router_questions(), model="multilingual", lang="vi")
        ans = result.get("answers", {})

        difficulty = float(ans.get("difficulty", {}).get("score", 3.0) or 3.0)
        domain_obj = ans.get("domain", {})
        domain = domain_obj.get("choice", "factual_lookup")
        needs_tools = float(ans.get("needs_tools", {}).get("noul", 0.0) or 0.0)
        is_sensitive = float(ans.get("is_sensitive", {}).get("noul", 0.0) or 0.0)

        difficulty_conf = float(ans.get("difficulty", {}).get("confidence", 0.0) or 0.0)
        domain_conf = float(domain_obj.get("confidence", 0.0) or 0.0)
        conf = min(difficulty_conf, domain_conf)

        if domain == "code":
            mode = "code"
        elif difficulty >= 1.6 or needs_tools >= 0.50 or is_sensitive >= 0.35:
            mode = "think"
        else:
            mode = "fast"

        # Weak System-1 confidence always escalates to the deeper path.
        if conf < LAYA_THRESHOLD and mode == "fast":
            mode = "think"

        return {
            "mode": mode,
            "confidence": round(conf, 4),
            "difficulty": round(difficulty, 4),
            "domain": domain,
            "needs_tools": round(needs_tools, 4),
            "is_sensitive": round(is_sensitive, 4),
            "source": "laya",
            "model": result.get("routing", {}).get("model", "multilingual"),
            "thinking": mode != "fast",
        }
    except Exception as exc:
        fallback = heuristic_decision(unicode_text)
        fallback["laya_error"] = f"{type(exc).__name__}: {exc}"
        return fallback


def nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text or "")


SYSTEM_PROMPT = """Bạn là BILAtiny, một trợ lý tiếng Việt.

Kiến trúc làm việc:
- CVNSS4.0 là biểu diễn nén/trung gian cho phần tiếng Việt. Khi có trường CVNSS4, hãy ưu tiên dùng nó như biểu diễn làm việc phụ trợ cùng với bản Unicode để giữ nhất quán ý nghĩa.
- Laya đã chọn chế độ xử lý trước khi yêu cầu đến bạn; không cần mô phỏng lại Laya.
- Không xuất chuỗi suy luận nội bộ/chain-of-thought. Chỉ trả câu trả lời cuối cùng hữu ích.
- Câu trả lời cuối phải là tiếng Việt chuẩn Unicode NFC, dấu tiếng Việt đầy đủ. Không trả CVNSS4.0 trừ khi người dùng yêu cầu rõ ràng.
- Với code, giữ nguyên cú pháp ngôn ngữ lập trình; phần giải thích vẫn dùng tiếng Việt Unicode.
"""


@app.get("/api/health")
async def health(x_deepseek_key: str | None = Header(default=None)):
    return {
        "ok": True,
        "laya_enabled": LAYA_ENABLED,
        "laya_preload": LAYA_PRELOAD,
        "deepseek_model": DEFAULT_MODEL,
        "deepseek_key_configured": bool(x_deepseek_key or os.getenv("DEEPSEEK_API_KEY")),
    }


@app.post("/api/chat")
async def chat(req: ChatRequest, x_deepseek_key: str | None = Header(default=None)):
    api_key = (x_deepseek_key or os.getenv("DEEPSEEK_API_KEY", "")).strip()
    if not api_key:
        raise HTTPException(status_code=401, detail="Chưa cấu hình DeepSeek API key.")

    unicode_text = nfc(req.message_unicode).strip()
    cvnss_text = req.message_cvnss.strip()
    decision = laya_decision(unicode_text, cvnss_text)
    thinking_enabled = bool(req.force_thinking or decision.get("thinking", False))
    model = (req.model or DEFAULT_MODEL).strip()

    history = []
    for item in req.history[-12:]:
        history.append({"role": item.role, "content": nfc(item.content)})

    user_payload = (
        "[UNICODE_VI]\n" + unicode_text +
        "\n\n[CVNSS4_WORKING_REPRESENTATION]\n" + cvnss_text +
        "\n\nHãy trả lời cuối cùng bằng tiếng Việt Unicode NFC."
    )

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            *history,
            {"role": "user", "content": user_payload},
        ],
        "thinking": {"type": "enabled" if thinking_enabled else "disabled"},
        "reasoning_effort": "high" if thinking_enabled else "none",
        "stream": False,
    }

    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        response = await client.post(
            f"{DEEPSEEK_BASE_URL}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=body,
        )

    if response.status_code >= 400:
        detail = response.text[:1500]
        raise HTTPException(status_code=502, detail=f"DeepSeek API lỗi {response.status_code}: {detail}")

    data = response.json()
    try:
        message = data["choices"][0]["message"]
        answer = nfc(message.get("content") or "")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Phản hồi DeepSeek không hợp lệ: {exc}") from exc

    usage = data.get("usage") or {}
    usage_public = {
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "total_tokens": usage.get("total_tokens"),
        "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
        "latency_ms": round((time.perf_counter() - started) * 1000, 1),
    }

    return {
        "answer": answer,
        "model": model,
        "decision": decision,
        "usage": usage_public,
    }
