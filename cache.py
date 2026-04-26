from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

CACHE_DIR = Path(os.environ.get("ZDT_CACHE_DIR", Path.home() / ".zotero_dual_translate_cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def file_doc_id(pdf_path: str) -> str:
    p = Path(pdf_path).expanduser().resolve()
    st = p.stat()
    raw = f"{p}|{st.st_size}|{int(st.st_mtime)}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]


def _path(kind: str, key: str) -> Path:
    d = CACHE_DIR / kind
    d.mkdir(parents=True, exist_ok=True)
    safe = hashlib.sha256(key.encode("utf-8")).hexdigest()
    return d / f"{safe}.json"


def get_json(kind: str, key: str) -> Any | None:
    p = _path(kind, key)
    if not p.exists():
        return None
    return json.loads(p.read_text("utf-8"))


def set_json(kind: str, key: str, value: Any) -> None:
    _path(kind, key).write_text(json.dumps(value, ensure_ascii=False, indent=2), "utf-8")
