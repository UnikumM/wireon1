import React from 'react';
import { Music, RotateCcw, Import, FileText } from 'lucide-react';
import { Button } from '../../common/Button';
import { pluralize } from '../../../utils/plural';
import { UNKNOWN_ARTIST } from '../../../utils/placeholders';
import { formatDuration } from '../../../utils/time';
import { ICON } from '../../../styles/icons';
import { PLATFORM_CONFIG } from './platforms';
import type { PreviewState } from './types';

interface Props {
  preview: PreviewState;
  /** Строки для поиска вместе с уже готовыми треками. */
  previewCount: number;
  onBack: () => void;
  onStart: () => void;
  onClose: () => void;
}

/** Строка предпросмотра: и готовый трек, и строка для поиска показываются одинаково. */
interface PreviewRow {
  title: string;
  artist?: string;
  duration?: number;
}

/**
 * Второй шаг: что разобрали и что сейчас будем переносить.
 *
 * Шаги со второго по четвёртый выпадают при смене — каждый приходит
 * ответом на нажатие, и без движения переход читался подменой
 * содержимого окна, а не продвижением по шагам. Первый шаг нарочно
 * без класса: он появляется вместе с самим окном, и второе появление
 * поверх входа окна складывалось бы с ним.
 */
export const ImportPreviewStep: React.FC<Props> = ({ preview, previewCount, onBack, onStart, onClose }) => {
  const rows: PreviewRow[] = [
    ...preview.readyTracks.map((track) => ({
      title: track.title,
      artist: track.artist,
      duration: track.duration
    })),
    ...preview.items
  ];

  return (
    <div className="animate-drop-in stack gap-4">
      <div
        className="row gap-3 p-3 radius-md bg-surface-3 border-subtle"
      >
        <div
          className="radius-sm row justify-center shrink-0 bg-surface-2" style={{ width: '48px', height: '48px' }}
        >
          {preview.coverUrl ? (
            <img
              src={preview.coverUrl}
              alt={preview.title}
              className="fill-cover radius-sm"
            />
          ) : (
            <Music size={ICON.xl} className="text-faint" />
          )}
        </div>

        <div className="grow">
          <div className="row gap-2">
            <h4
              className="text-truncate m-0 text-base weight-semibold text-primary"
              data-testid="preview-playlist-title"
            >
              {preview.title}
            </h4>
            {preview.origin.kind === 'platform' ? (
              <span
                className="radius-xs text-xs weight-semibold" style={{ padding: '2px 6px', backgroundColor: PLATFORM_CONFIG[preview.origin.platform].bg, color: PLATFORM_CONFIG[preview.origin.platform].color }}
              >
                {PLATFORM_CONFIG[preview.origin.platform].name}
              </span>
            ) : (
              <span
                style={{ padding: '2px 6px', maxWidth: '190px' }}
                className="text-truncate inline-row radius-xs text-secondary text-xs weight-semibold gap-1 bg-surface-2"
                data-testid="preview-file-badge"
              >
                <FileText size={ICON.xs} aria-hidden="true" />
                {preview.origin.filename}
              </span>
            )}
          </div>
          <div className="text-xs text-muted mt-px">
            Найдено {pluralize(previewCount, 'трек', 'трека', 'треков')}
            {preview.readyTracks.length > 0 && preview.items.length > 0 && (
              <> · {preview.readyTracks.length} уже готовы к прослушиванию</>
            )}
          </div>
        </div>
      </div>

      {/* Список треков */}
      <div>
        <div className="text-xs text-secondary mb-2">
          Список треков ({previewCount}):
        </div>
        <div
          className="scrollbar-thin radius-md p-1 border-subtle bg-surface-2"
          style={{ maxHeight: '220px', overflowY: 'auto' }}
          data-testid="preview-track-list"
        >
          {rows.map((item, idx, all) => (
            <div
              key={idx}
              className="row justify-between text-sm py-2 px-3" style={{ borderBottom: idx < all.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}
            >
              <div className="row gap-2 grow">
                <span className="text-muted text-xs" style={{ width: '20px' }}>
                  {idx + 1}
                </span>
                <div className="text-truncate">
                  <span className="text-primary weight-medium">{item.title}</span>
                  <span className="text-secondary ml-2">
                    — {item.artist || UNKNOWN_ARTIST}
                  </span>
                </div>
              </div>
              {item.duration ? (
                <span data-numeric className="text-muted text-xs shrink-0">
                  {formatDuration(item.duration)}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="row justify-between mt-2">
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCcw size={ICON.sm} />}
          onClick={onBack}
        >
          Другой источник
        </Button>

        <div className="row-stretch gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            icon={<Import size={ICON.md} />}
            onClick={onStart}
            data-testid="start-import-btn"
          >
            {preview.items.length === 0
              ? `Перенести (${previewCount})`
              : `Найти и перенести (${previewCount})`}
          </Button>
        </div>
      </div>
    </div>
  );
};
