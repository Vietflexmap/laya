"""Optional Laya-only decision service for BILAtiny.

DeepSeek/OpenRouter is called directly by the browser. This service exists only to run the real
Laya multilingual model and return a small routing decision. If it is not configured, the web UI
falls back to a deterministic local decision gate.
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

LAYA_PRELOAD = os.getenv("LAYA_PRELOAD", "0").strip().lower() in {"1", "true", "yes", "on"}
LAYA_THRESHOLD = float(os.getenv("LAYA_CONFIDENCE_THRESHOLD", "0.78"))
_ALLOWED_DEFAULT = "http://127.0.0.1:5500,http://localhost:5500,https://vietflexmap.github.io"
ALLOWED_ORIGINS = [x.strip() for x in os.getenv("ALLOWED_ORIGINS", _ALLOWED_DEFAULT).split(",") if x.strip()]

app = FastAPI(title="BILAtiny Laya Decision Gate", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


class DecisionRequest(BaseModel):
    message_unicode: str = Field(min_length=1, max_length=50_000)
    message_cvnss: str = Field(min_length=1, max_length=50_000)


@lru_cache(maxsize=1)
def get_router():
    from laya import Router

    router = Router(default="multilingual", max_loaded=1)
    if LAYA_PRELOAD:
        router.preload(["multilingual"])
    return router


def decide(unicode_text: str, cvnss_text: str) -> dict[str, Any]:
    from laya import router_questions

    router = get_router()
    state = {
        "request": unicode_text,
        "cvnss4": cvnss_text,
        "language": "vi",
    }
    result = router.predict(state, router_questions(), model="multilingual", lang="vi")
    answers = result.get("answers", {})

    difficulty = float(answers.get("difficulty", {}).get("score", 3.0) or 3.0)
    domain_obj = answers.get("domain", {})
    domain = domain_obj.get("choice", "factual_lookup")
    needs_tools = float(answers.get("needs_tools", {}).get("noul", 0.0) or 0.0)
    is_sensitive = float(answers.get("is_sensitive", {}).get("noul", 0.0) or 0.0)

    difficulty_conf = float(answers.get("difficulty", {}).get("confidence", 0.0) or 0.0)
    domain_conf = float(domain_obj.get("confidence", 0.0) or 0.0)
    confidence = min(difficulty_conf, domain_conf)

    if domain == "code":
        mode = "code"
    elif difficulty >= 1.6 or needs_tools >= 0.50 or is_sensitive >= 0.35:
        mode = "think"
    else:
        mode = "fast"

    if confidence < LAYA_THRESHOLD and mode == "fast":
        mode = "think"

    return {
        "mode": mode,
        "domain": domain,
        "difficulty": round(difficulty, 4),
        "needs_tools": round(needs_tools, 4),
        "is_sensitive": round(is_sensitive, 4),
        "confidence": round(confidence, 4),
        "thinking": mode != "fast",
        "source": "laya",
        "model": result.get("routing", {}).get("model", "multilingual"),
    }


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "service": "laya-decision-gate",
        "preload": LAYA_PRELOAD,
        "threshold": LAYA_THRESHOLD,
    }


@app.post("/api/decide")
async def decision(req: DecisionRequest):
    return decide(req.message_unicode, req.message_cvnss)
