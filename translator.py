from __future__ import annotations

import os

import httpx

from models import LayoutBlock


LANG_MAP: dict[str, str | None] = {
    "pt-BR": "pt",
}


class Translator:
    async def translate_blocks(self, blocks: list[LayoutBlock], target_lang: str, source_lang: str | None = None) -> list[str]:
        raise NotImplementedError


class MockTranslator(Translator):
    async def translate_blocks(self, blocks: list[LayoutBlock], target_lang: str, source_lang: str | None = None) -> list[str]:
        return [f"[{target_lang}] {b.text}" for b in blocks]


class OpenAICompatibleTranslator(Translator):
    def __init__(self) -> None:
        self.base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
        self.api_key = os.environ.get("OPENAI_API_KEY", "")
        self.model = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")
        if not self.api_key:
            raise RuntimeError("OPENAI_API_KEY is required for TRANSLATOR=openai")

    async def translate_blocks(self, blocks: list[LayoutBlock], target_lang: str, source_lang: str | None = None) -> list[str]:
        payload_lines = [f"{b.id}: {b.text}" for b in blocks]
        prompt = (
            f"Translate each line to {target_lang}. Preserve the line id exactly and return only lines in the form 'id: translation'.\n"
            + "\n".join(payload_lines)
        )
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(
                f"{self.base_url.rstrip('/')}/chat/completions",
                headers=headers,
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0,
                },
            )
            r.raise_for_status()
            text = r.json()["choices"][0]["message"]["content"]
        by_id: dict[str, str] = {}
        for line in text.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                by_id[k.strip()] = v.strip()
        return [by_id.get(b.id, b.text) for b in blocks]


class GoogleTranslator(Translator):
    def __init__(self, service_id: str) -> None:
        self.service_id = service_id
        self.default_url = (
            "https://translate.google.com"
            if service_id == "google"
            else "https://translate.googleapis.com"
        )
        self.base_url = os.environ.get("GOOGLE_TRANSLATE_BASE_URL", "").strip() or self.default_url
        self.secret = os.environ.get("GOOGLE_TRANSLATE_SECRET", "").strip() or None
        self.timeout = float(os.environ.get("GOOGLE_TRANSLATE_TIMEOUT", "30"))

    async def translate_blocks(self, blocks: list[LayoutBlock], target_lang: str, source_lang: str | None = None) -> list[str]:
        cache: dict[tuple[str, str, str], str] = {}
        results: list[str] = []
        async with httpx.AsyncClient(
            timeout=self.timeout,
            headers={
                "User-Agent": "Mozilla/5.0 Zotero-Dual-Translate/0.3",
            },
        ) as client:
            for block in blocks:
                text = block.text.strip()
                if not text:
                    results.append("")
                    continue
                key = (source_lang or "auto", target_lang, text)
                if key not in cache:
                    cache[key] = await self._translate_text(client, text, target_lang, source_lang)
                results.append(cache[key])
        return results

    async def _translate_text(
        self,
        client: httpx.AsyncClient,
        text: str,
        target_lang: str,
        source_lang: str | None,
    ) -> str:
        langfrom = self._map_lang(source_lang, default="auto")
        langto = self._map_lang(target_lang, default=target_lang)
        base_url = (self.secret or self.base_url).rstrip("/")
        params: list[tuple[str, str]] = [
            ("client", "gtx"),
            ("sl", langfrom),
            ("tl", langto),
            ("hl", "en"),
            ("source", "bh"),
            ("ssel", "0"),
            ("tsel", "0"),
            ("kc", "1"),
            ("tk", self._tl(text)),
            ("q", text),
        ]
        for dt in ["at", "bd", "ex", "ld", "md", "qca", "rw", "rm", "ss", "t"]:
            params.append(("dt", dt))

        response = await client.get(f"{base_url}/translate_a/single", params=params)
        if response.status_code != 200:
            raise RuntimeError(f"Request error: {response.status_code}")

        payload = response.json()
        translated_parts: list[str] = []
        for part in payload[0] if payload and payload[0] else []:
            if part and len(part) > 0 and part[0]:
                translated_parts.append(str(part[0]))
        translated = "".join(translated_parts).strip()
        return translated or text

    def _map_lang(self, lang: str | None, default: str) -> str:
        if not lang:
            return default
        return LANG_MAP.get(lang, lang) or default

    def _tl(self, text: str) -> str:
        b = 406644
        b1 = 3293161072
        a = b
        for value in text.encode("utf-8"):
            a += value
            a = self._rl(a, "+-a^+6")
        a = self._rl(a, "+-3^+b+-f")
        a ^= b1 or 0
        if a < 0:
            a = (a & 2147483647) + 2147483648
        a %= 1_000_000
        return f"{a}.{a ^ b}"

    def _rl(self, value: int, rule: str) -> int:
        for index in range(0, len(rule) - 2, 3):
            shift = rule[index + 2]
            amount = ord(shift) - 87 if shift >= "a" else int(shift)
            transformed = value >> amount if rule[index + 1] == "+" else value << amount
            value = ((value + transformed) & 4294967295) if rule[index] == "+" else value ^ transformed
        return value


def get_translator() -> Translator:
    name = os.environ.get("TRANSLATOR", "google").lower().strip()
    if name == "openai":
        return OpenAICompatibleTranslator()
    if name == "google":
        return GoogleTranslator("google")
    if name == "googleapi":
        return GoogleTranslator("googleapi")
    return MockTranslator()
