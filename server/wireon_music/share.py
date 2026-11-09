"""
Страница «поделиться треком» (4.0, фича 26).

Ссылка вида `/t/yt/<id>?n=<название>&a=<артист>&img=<обложка>` открывается в
любом мессенджере карточкой: заголовок, исполнитель, обложка (Open Graph), а на
самой странице — кнопка «Открыть в Wireon» (`wireon://track/...`) и ссылка на
источник. Сведения о треке приходят в самой ссылке, а не ищутся сервером: у
него нет каталога, и ходить за названием в YouTube ради каждой карточки
значило бы делать публичную ручку, гоняющую внешние запросы. Всё, что пришло,
экранируется; длина обрезается.

Страница публичная — без токена: ей как раз и должны открываться чужие люди.
Ограничение по частоте остаётся.
"""

from __future__ import annotations

import html
import re
from typing import Dict, Optional
from urllib.parse import quote

SOURCES: Dict[str, str] = {"yt": "youtube", "sc": "soundcloud"}
SOURCE_LABEL = {"youtube": "YouTube", "soundcloud": "SoundCloud"}
MAX_TEXT = 160
MAX_URL = 600
_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
_HTTPS_IMG_RE = re.compile(r"^https://[^\s\"'<>]+$")
_SC_URL_RE = re.compile(r"^https://(?:(?:www|m)\.)?(?:on\.)?soundcloud\.com/[^\s\"'<>]+$")


def _clip(value: Optional[str], limit: int) -> str:
    return (value or "").strip()[:limit]


def source_url(source: str, track_id: str, permalink: str = "") -> str:
    if source == "youtube":
        return f"https://music.youtube.com/watch?v={quote(track_id)}"
    # У SoundCloud по числовому id страницы нет, поэтому приложение кладёт в
    # ссылку адрес записи (`u`); без него остаётся только поиск.
    if _SC_URL_RE.match(permalink):
        return permalink
    return f"https://soundcloud.com/search?q={quote(track_id)}"


def render_share_page(source_key: str, track_id: str, query: Dict[str, str]) -> Optional[str]:
    """HTML страницы или None, если ссылка не похожа на ссылку на трек."""
    source = SOURCES.get(source_key)
    if not source or not _ID_RE.match(track_id or ""):
        return None
    title = _clip(query.get("n"), MAX_TEXT) or "Трек"
    artist = _clip(query.get("a"), MAX_TEXT)
    image = _clip(query.get("img"), MAX_URL)
    if not _HTTPS_IMG_RE.match(image):
        image = ""
    permalink = _clip(query.get("u"), MAX_URL)
    if not _SC_URL_RE.match(permalink):
        permalink = ""
    deep = f"wireon://track/{source_key}/{track_id}"
    if source == "soundcloud" and permalink:
        deep += f"?u={quote(permalink, safe='')}"
    origin = source_url(source, track_id, permalink)
    heading = f"{artist} — {title}" if artist else title
    e = html.escape
    og_image = f'<meta property="og:image" content="{e(image)}">' if image else ""
    cover = (
        f'<img class="cover" src="{e(image)}" alt="">'
        if image
        else '<div class="cover cover-empty" aria-hidden="true">♪</div>'
    )
    return f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(heading)} · Wireon</title>
<meta property="og:type" content="music.song">
<meta property="og:site_name" content="Wireon">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(artist or SOURCE_LABEL[source])}">
{og_image}
<meta name="twitter:card" content="summary">
<style>
  :root {{ color-scheme: dark; }}
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0e0f12; color: #efeff1;
         font: 16px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }}
  .card {{ width: min(92vw, 420px); padding: 24px; border-radius: 20px; background: #141619; border: 1px solid rgba(255,255,255,.07);
           box-shadow: 0 30px 80px -40px rgba(0,0,0,.8); text-align: center; }}
  .cover {{ width: 220px; height: 220px; border-radius: 16px; object-fit: cover; display: block; margin: 0 auto 20px;
            box-shadow: 0 24px 60px -24px rgba(0,0,0,.9); }}
  .cover-empty {{ display: grid; place-items: center; background: #1f2127; color: #6f7480; font-size: 72px; }}
  h1 {{ font-size: 22px; margin: 0 0 4px; }}
  p {{ margin: 0 0 20px; color: #b5b8bf; }}
  a.btn {{ display: block; padding: 14px 20px; border-radius: 999px; text-decoration: none; font-weight: 600; margin-top: 10px; }}
  a.primary {{ background: #8fc7ff; color: #0b0f16; }}
  a.ghost {{ color: #efeff1; border: 1px solid rgba(255,255,255,.12); }}
  small {{ display: block; margin-top: 16px; color: #6f7480; }}
</style>
</head>
<body>
<main class="card">
  {cover}
  <h1>{e(title)}</h1>
  <p>{e(artist or "")}</p>
  <a class="btn primary" href="{e(deep)}">Открыть в Wireon</a>
  <a class="btn ghost" href="{e(origin)}" rel="noopener">Открыть на {SOURCE_LABEL[source]}</a>
  <small>Wireon — музыка с YouTube и SoundCloud, бесплатно и без рекламы.</small>
</main>
</body>
</html>"""
