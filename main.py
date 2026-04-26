from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from cache import file_doc_id, get_json, set_json
from models import RegisterDocumentRequest, RegisterDocumentResponse, TranslateRequest, TranslateResponse, PageLayout
from pdf_parser import extract_pages_lazy, page_count, requested_pages, validate_pdf_path
from translator import get_translator

logger = logging.getLogger("dual_translate")
logger.setLevel(logging.INFO)

app = FastAPI(title="Zotero Dual Translate", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    logger.info("health ok version=%s", app.version)
    return {"ok": True, "service": "zotero-dual-translate", "version": app.version}


@app.post("/documents/register", response_model=RegisterDocumentResponse)
def register_document(req: RegisterDocumentRequest):
    p = validate_pdf_path(req.pdf_path)
    doc_id = file_doc_id(str(p))
    total = page_count(str(p))
    logger.info("register_document doc_id=%s pdf_path=%s page_count=%s", doc_id, p, total)
    return RegisterDocumentResponse(doc_id=doc_id, pdf_path=str(p), page_count=total)


@app.post("/translate", response_model=TranslateResponse)
async def translate(req: TranslateRequest):
    p = validate_pdf_path(req.pdf_path)
    doc_id = file_doc_id(str(p))
    total = page_count(str(p))
    pages = requested_pages(req.page, req.radius, total)
    logger.info(
        "translate start doc_id=%s page=%s radius=%s target=%s source=%s total=%s pages=%s pdf_path=%s",
        doc_id,
        req.page,
        req.radius,
        req.target_lang,
        req.source_lang,
        total,
        pages,
        p,
    )
    if not pages:
        logger.error("translate invalid pages doc_id=%s requested_page=%s radius=%s total=%s", doc_id, req.page, req.radius, total)
        raise HTTPException(400, "No valid pages requested")

    layouts = extract_pages_lazy(str(p), pages)
    logger.info(
        "translate layouts doc_id=%s requested_page=%s page_count=%s block_counts=%s",
        doc_id,
        req.page,
        len(layouts),
        {layout.page: len(layout.blocks) for layout in layouts},
    )
    if not any(b.text.strip() for layout in layouts for b in layout.blocks):
        logger.warning("translate unsupported doc_id=%s requested_page=%s reason=no_embedded_text", doc_id, req.page)
        return TranslateResponse(
            doc_id=doc_id,
            requested_page=req.page,
            pages=layouts,
            status="unsupported",
            reason="No embedded text was found on the requested pages. This looks scanned/image-only, and OCR is disabled.",
        )

    translator = get_translator()
    logger.info("translate translator=%s doc_id=%s", translator.__class__.__name__, doc_id)
    translated_pages: list[PageLayout] = []
    for layout in layouts:
        cache_key = f"{doc_id}:page:{layout.page}:target:{req.target_lang}:translator:{translator.__class__.__name__}:v2"
        cached = get_json("translation", cache_key)
        if cached:
            logger.info("translate cache_hit doc_id=%s page=%s", doc_id, layout.page)
            translated_pages.append(PageLayout.model_validate(cached))
            continue
        blocks = [b for b in layout.blocks if b.text.strip()]
        logger.info("translate page_start doc_id=%s page=%s blocks=%s", doc_id, layout.page, len(blocks))
        translations = await translator.translate_blocks(blocks, req.target_lang, req.source_lang)
        for block, tx in zip(blocks, translations):
            block.translated_text = tx
        set_json("translation", cache_key, layout.model_dump())
        logger.info("translate page_done doc_id=%s page=%s translated_blocks=%s", doc_id, layout.page, len(blocks))
        translated_pages.append(layout)

    logger.info(
        "translate done doc_id=%s requested_page=%s response_pages=%s",
        doc_id,
        req.page,
        [layout.page for layout in translated_pages],
    )
    return TranslateResponse(doc_id=doc_id, requested_page=req.page, pages=translated_pages)
