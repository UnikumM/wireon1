import type { PlatformType, ParsedPlaylistItem, ImportMatch } from '../../../services/playlistImporter';
import type { UnifiedTrack } from '../../../types/music';

export interface ImportPlaylistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImported?: (playlistId: string) => void;
}

export type ImportStep = 'input' | 'preview' | 'resolving' | 'complete';

/** Откуда пришёл плейлист: со стороннего сервиса или из файла. */
export type PreviewOrigin =
  | { kind: 'platform'; platform: PlatformType }
  | { kind: 'file'; filename: string };

export interface PreviewState {
  title: string;
  description?: string;
  coverUrl?: string;
  /** Строки, которые придётся искать в источниках. */
  items: ParsedPlaylistItem[];
  /** Готовые треки — так переносится наш собственный файл, без поиска. */
  readyTracks: UnifiedTrack[];
  origin: PreviewOrigin;
}

/** Состояние ручного выбора для одной ненайденной строки. */
export interface ManualState {
  candidates: UnifiedTrack[] | null;
  isSearching: boolean;
  addedId?: string;
}

/** Ход поиска по источникам на третьем шаге. */
export interface ResolveProgress {
  resolved: number;
  total: number;
  current?: string;
}

/** Строка отчёта вместе с её номером — номер нужен для ручного выбора. */
export interface IndexedMatch {
  match: ImportMatch;
  index: number;
}
