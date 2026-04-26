from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import fitz  # PyMuPDF
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling_core.types.doc import (
    CodeItem,
    ContentLayer,
    DocItem,
    DoclingDocument,
    FormulaItem,
    ListItem,
    PictureItem,
    SectionHeaderItem,
    TableItem,
    TextItem,
    TitleItem,
)
from fastapi import HTTPException

from cache import file_doc_id, get_json, set_json
from models import LayoutBlock, PageLayout


def validate_pdf_path(pdf_path: str) -> Path:
    p = Path(pdf_path).expanduser().resolve()
    if p.suffix.lower() != ".pdf":
        raise HTTPException(status_code=400, detail="Only original PDF files are supported. Images are intentionally rejected.")
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"PDF not found: {p}")
    return p


def page_count(pdf_path: str) -> int:
    p = validate_pdf_path(pdf_path)
    with fitz.open(p) as doc:
        return doc.page_count


def requested_pages(page: int, radius: int, total: int) -> list[int]:
    start = max(1, page - radius)
    end = min(total, page + radius)
    return list(range(start, end + 1))


@lru_cache(maxsize=1)
def get_docling_converter() -> DocumentConverter:
    options = PdfPipelineOptions()
    options.do_ocr = False
    options.do_table_structure = True
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=options),
        },
    )


def extract_pages_lazy(pdf_path: str, pages: list[int]) -> list[PageLayout]:
    """Extract requested page layouts with Docling as the primary parser.

    The parser preserves Docling labels, item classes, and content layers so the
    frontend can distinguish text from passthrough visual regions such as images.
    """

    p = validate_pdf_path(pdf_path)
    doc_id = file_doc_id(str(p))
    ordered_pages = [page for page in pages if page >= 1]
    if not ordered_pages:
        return []

    layouts_by_page: dict[int, PageLayout] = {}
    missing_pages: list[int] = []

    for page_no in ordered_pages:
        cache_key = _layout_cache_key(doc_id, page_no)
        cached = get_json("layout", cache_key)
        if cached:
            layouts_by_page[page_no] = PageLayout.model_validate(cached)
        elif page_no not in missing_pages:
            missing_pages.append(page_no)

    if missing_pages:
        parsed_layouts = _extract_missing_pages_with_docling(str(p), missing_pages)
        for layout in parsed_layouts:
            layouts_by_page[layout.page] = layout
            set_json("layout", _layout_cache_key(doc_id, layout.page), layout.model_dump())

    return [layouts_by_page[page_no] for page_no in ordered_pages if page_no in layouts_by_page]


def _extract_missing_pages_with_docling(pdf_path: str, pages: list[int]) -> list[PageLayout]:
    converter = get_docling_converter()
    result = converter.convert(pdf_path, page_range=(min(pages), max(pages)))
    doc = result.document

    fallback_sizes = _load_page_sizes(pdf_path, pages)
    layouts: list[PageLayout] = []
    for page_no in sorted(set(pages)):
        page = doc.pages.get(page_no)
        if page is not None:
            width = float(page.size.width)
            height = float(page.size.height)
        else:
            width, height = fallback_sizes.get(page_no, (1.0, 1.0))

        blocks: list[LayoutBlock] = []
        reading_order = 0
        for item, _level in doc.iterate_items(
            page_no=page_no,
            with_groups=False,
            traverse_pictures=True,
            included_content_layers=set(ContentLayer),
        ):
            block = _docling_item_to_block(doc, item, page_no, height, reading_order + 1)
            if block is None:
                continue
            reading_order += 1
            block.reading_order = reading_order
            blocks.append(block)

        layouts.append(PageLayout(page=page_no, width=width, height=height, blocks=blocks))

    return layouts

pass_through_kind = ['picture','table','code']

def _docling_item_to_block(
    doc: DoclingDocument,
    item: DocItem,
    page_no: int,
    page_height: float,
    order: int,
) -> LayoutBlock | None:
    prov = next(
        (
            prov
            for prov in getattr(item, "prov", [])
            if prov.page_no == page_no and prov.bbox is not None
        ),
        None,
    )
    if prov is None:
        return None

    bbox = prov.bbox.to_top_left_origin(page_height)
    x0 = float(bbox.l)
    y0 = float(bbox.t)
    x1 = float(bbox.r)
    y1 = float(bbox.b)
    if x1 <= x0 or y1 <= y0:
        return None

    docling_label = _label_value(item)
    item_type = item.__class__.__name__
    content_layer = _content_layer_value(item)
    content_kind = _content_kind(item)
    block_type = _block_type(item, docling_label)
    render_mode = "passthrough" if content_kind in pass_through_kind else "translate"
    text = _extract_item_text(doc, item)

    if not text and render_mode != "passthrough":
        return None

    font_size_hint = (
        _estimate_font_size(y1 - y0, text, block_type)
        if render_mode == "translate" and text
        else None
    )

    return LayoutBlock(
        id=f"p{page_no}-b{order}",
        page=page_no,
        bbox=[x0, y0, x1, y1],
        text=text,
        type=block_type,
        docling_label=docling_label,
        docling_item_type=item_type,
        content_layer=content_layer,
        content_kind=content_kind,
        render_mode=render_mode,
        reading_order=order,
        font_size_hint=font_size_hint,
    )


def _extract_item_text(doc: DoclingDocument, item: DocItem) -> str:
    if isinstance(item, PictureItem):
        # Picture regions must remain visual passthrough blocks; captions are
        # separate Docling text items and should not be projected onto the image bbox.
        return ""
    if isinstance(item, TableItem):
        try:
            return str(item.export_to_markdown(doc=doc) or "").strip()
        except TypeError:
            return str(item.export_to_markdown() or "").strip()
    if isinstance(item, TextItem):
        return str(item.text or "").strip()
    return str(getattr(item, "text", "") or "").strip()


def _label_value(item: DocItem) -> str:
    label = getattr(item, "label", None)
    if hasattr(label, "value"):
        return str(label.value).strip().lower()
    return str(label or "").strip().lower()


def _content_layer_value(item: DocItem) -> str:
    layer = getattr(item, "content_layer", ContentLayer.BODY)
    if hasattr(layer, "value"):
        return str(layer.value)
    return str(layer)


def _content_kind(item: DocItem) -> str:
    if isinstance(item, PictureItem):
        return "picture"
    if isinstance(item, TableItem):
        return "table"
    if isinstance(item, FormulaItem):
        return "formula"
    if isinstance(item, CodeItem):
        return "code"
    if isinstance(item, TextItem):
        return "text"
    return "other"


def _block_type(item: DocItem, label: str) -> str:
    if isinstance(item, (TitleItem, SectionHeaderItem)):
        return "title"
    if isinstance(item, ListItem):
        return "list"
    if isinstance(item, TableItem):
        return "table"
    if isinstance(item, PictureItem):
        return "picture"
    if isinstance(item, FormulaItem):
        return "formula"
    if isinstance(item, CodeItem):
        return "code"

    label_map = {
        "caption": "caption",
        "footnote": "footnote",
        "page_header": "header",
        "page_footer": "footer",
        "reference": "reference",
        "title": "title",
        "section_header": "title",
    }
    return label_map.get(label, "paragraph")


def _estimate_font_size(box_height: float, text: str, block_type: str) -> float:
    line_count = max(1, text.count("\n") + 1)
    estimated = box_height / line_count * 0.72
    if block_type == "title":
        estimated = max(estimated, 16.0)
    elif block_type == "caption":
        estimated = min(estimated, 11.5)
    elif block_type in {"header", "footer", "footnote"}:
        estimated = min(estimated, 10.5)
    return max(8.0, min(26.0, estimated))


def _layout_cache_key(doc_id: str, page_no: int) -> str:
    return f"{doc_id}:page:{page_no}:layout:v4-docling-types"


def _load_page_sizes(pdf_path: str, pages: list[int]) -> dict[int, tuple[float, float]]:
    sizes: dict[int, tuple[float, float]] = {}
    with fitz.open(pdf_path) as doc:
        for page_no in sorted(set(pages)):
            if page_no < 1 or page_no > doc.page_count:
                continue
            page = doc.load_page(page_no - 1)
            sizes[page_no] = (float(page.rect.width), float(page.rect.height))
    return sizes
