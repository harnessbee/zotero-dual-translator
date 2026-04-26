from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import fitz
from PIL import Image

from pdf_parser import extract_pages_lazy


class DoclingParserTests(unittest.TestCase):
    def test_picture_items_keep_type_info_and_do_not_consume_caption_text(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            image_path = tmp / "probe.png"
            pdf_path = tmp / "probe.pdf"

            Image.new("RGB", (120, 80), (220, 60, 60)).save(image_path)

            doc = fitz.open()
            page = doc.new_page(width=595, height=842)
            page.insert_text((72, 90), "Figure 1 sample", fontsize=18)
            page.insert_image(fitz.Rect(72, 140, 300, 320), filename=str(image_path))
            page.insert_textbox(
                fitz.Rect(72, 330, 320, 380),
                "Figure 1. Red sample image caption",
                fontsize=12,
            )
            page.insert_textbox(
                fitz.Rect(72, 420, 500, 520),
                "A paragraph below the image.",
                fontsize=12,
            )
            doc.save(pdf_path)
            doc.close()

            layouts = extract_pages_lazy(str(pdf_path), [1])
            self.assertEqual(len(layouts), 1)
            blocks = layouts[0].blocks

            picture_blocks = [block for block in blocks if block.type == "picture"]
            self.assertEqual(len(picture_blocks), 1)
            picture = picture_blocks[0]
            self.assertEqual(picture.docling_item_type, "PictureItem")
            self.assertEqual(picture.docling_label, "picture")
            self.assertEqual(picture.content_kind, "picture")
            self.assertEqual(picture.content_layer, "body")
            self.assertEqual(picture.render_mode, "passthrough")
            self.assertEqual(picture.text, "")

            text_values = [block.text for block in blocks if block.text]
            self.assertIn("Figure 1. Red sample image caption", text_values)
            self.assertIn("A paragraph below the image.", text_values)
            self.assertNotEqual(
                picture.text,
                "Figure 1. Red sample image caption",
            )


if __name__ == "__main__":
    unittest.main()
