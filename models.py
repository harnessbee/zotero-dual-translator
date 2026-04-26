from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


BlockType = Literal[
    "text",
    "title",
    "paragraph",
    "list",
    "table",
    "caption",
    "formula",
    "picture",
    "code",
    "header",
    "footer",
    "footnote",
    "reference",
    "other",
]
ContentLayerName = Literal["body", "furniture", "background", "invisible", "notes"]
ContentKind = Literal["text", "picture", "table", "formula", "code", "other"]
RenderMode = Literal["translate", "passthrough"]


class RegisterDocumentRequest(BaseModel):
    pdf_path: str
    attachment_item_id: int | None = None
    zotero_item_id: int | None = None


class RegisterDocumentResponse(BaseModel):
    doc_id: str
    pdf_path: str
    page_count: int


class LayoutBlock(BaseModel):
    id: str
    page: int
    bbox: list[float] = Field(description="[x0, y0, x1, y1] in PDF point coordinates")
    text: str
    translated_text: str | None = None
    type: BlockType = "paragraph"
    docling_label: str = "text"
    docling_item_type: str = "TextItem"
    content_layer: ContentLayerName = "body"
    content_kind: ContentKind = "text"
    render_mode: RenderMode = "translate"
    reading_order: int = 0
    font_size_hint: float | None = None


class PageLayout(BaseModel):
    page: int
    width: float
    height: float
    blocks: list[LayoutBlock]


class TranslateRequest(BaseModel):
    pdf_path: str
    page: int = Field(ge=1)
    radius: int = Field(default=1, ge=0, le=5)
    target_lang: str = "zh-CN"
    source_lang: str | None = None


class TranslateResponse(BaseModel):
    doc_id: str
    requested_page: int
    pages: list[PageLayout]
    status: Literal["ok", "unsupported"] = "ok"
    reason: str | None = None
