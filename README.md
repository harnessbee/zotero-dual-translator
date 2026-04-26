# Zotero Dual Translate MVP

A deliberately small working version of a Zotero 7 side-by-side PDF translation plugin.

It is designed for **large original PDFs** with embedded text. It does **not** OCR scanned/image-only PDFs.

## What this MVP does

- Adds a `Compare Translation` button to Zotero Reader.
- Opens a right-side translated layout panel.
- Sends only the current page plus nearby pages to a local service.
- Extracts layout/text from requested pages only.
- Caches page layout and translation results on disk.
- Uses a mock translator by default, so the full pipeline works without API keys.
- Optionally calls Docling with `page_range=(start, end)` and `do_ocr=False` for lazy page-range parsing.



## Run the local service

```bash
cd service
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
./run.sh
```

Health check:

```bash
curl http://127.0.0.1:8765/health
```

Test translation:

```bash
curl -X POST http://127.0.0.1:8765/translate \
  -H 'Content-Type: application/json' \
  -d '{"pdf_path":"/absolute/path/to/paper.pdf","page":1,"radius":1,"target_lang":"zh-CN"}'
```

## Enable optional Docling page-range parsing

The MVP uses PyMuPDF for the renderable bounding boxes because it is fast and stable for embedded PDF text. To also invoke Docling lazily for only the requested page range:

```bash
export ZDT_DOCLING=1
./run.sh
```

