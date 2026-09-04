"""
Модуль интеграции музыкального сервера Wireon в фоновые службы.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger("wireon.music_hook")

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


async def start_music() -> Optional[object]:
    """
    Поднимает музыкальный сервер. Возвращает runner либо None.
    """
    token = os.getenv("WIREON_API_TOKEN", "").strip()
    if not token:
        logger.warning("WIREON_API_TOKEN не задан в .env — музыкальный сервер не поднят.")
        return None

    try:
        from wireon_music import start_music_server
    except Exception as exc:  # noqa: BLE001
        logger.error("музыкальный сервер не загрузился: %s", exc)
        return None

    try:
        runner = await start_music_server()
    except Exception as exc:  # noqa: BLE001
        logger.error("музыкальный сервер не запустился: %s", exc)
        return None

    if runner is None:
        logger.error("музыкальный сервер не занял порт")
    return runner
