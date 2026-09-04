"""
Музыкальный сервер Wireon.

Предоставляет API резолвинга аудиопотоков, брокер синхронизации
и облачное хранилище плейлистов.
"""

from .app import create_app, start_music_server
from .resolver import ResolveError, ResolvedStream, StreamResolver

__all__ = [
    "create_app",
    "start_music_server",
    "StreamResolver",
    "ResolvedStream",
    "ResolveError",
]
