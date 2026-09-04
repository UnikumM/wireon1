import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Share2, FileJson, ListMusic, Table2, ClipboardCopy } from 'lucide-react';
import type { Playlist } from '../../types/music';
import {
  EXPORT_FORMAT_HINTS,
  EXPORT_FORMAT_LABELS,
  exportPlaylist,
  type ExportFormat
} from '../../services/playlistTransfer';
import { downloadTextFile } from '../../utils/download';
import { useUIStore } from '../../store/useUIStore';
import { pluralize } from '../../utils/plural';
import { UNKNOWN_ARTIST, UNKNOWN_TITLE } from '../../utils/placeholders';
import { ICON } from '../../styles/icons';

export interface PlaylistExportMenuProps {
  playlist: Playlist;
}

const FORMAT_ORDER: ExportFormat[] = ['wireon', 'm3u8', 'csv'];

const FORMAT_ICON: Record<ExportFormat, React.ReactNode> = {
  wireon: <FileJson size={ICON.md} aria-hidden="true" />,
  m3u8: <ListMusic size={ICON.md} aria-hidden="true" />,
  csv: <Table2 size={ICON.md} aria-hidden="true" />
};

/**
 * Вынос плейлиста в файл — или в буфер обмена, если им делятся в переписке.
 *
 * Три формата вместо одного: наш JSON переносит плейлист в другой Wireon Sounds без
 * потерь, m3u8 открывается во внешних плеерах, csv читают таблицы и сервисы.
 */
export const PlaylistExportMenu: React.FC<PlaylistExportMenuProps> = ({ playlist }) => {
  const showToast = useUIStore((s) => s.showToast);
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((restoreFocus = true) => {
    setIsOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setIsOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [close, isOpen]);

  const handleExport = useCallback(
    (format: ExportFormat) => {
      close(false);
      if (playlist.tracks.length === 0) {
        showToast('В плейлисте нет треков — выносить нечего', 'info');
        return;
      }

      try {
        const file = exportPlaylist(playlist, format);
        const saved = downloadTextFile(file.filename, file.mimeType, file.content);
        if (!saved) {
          showToast('Сохранить файл не получилось — попробуйте ещё раз', 'error');
          return;
        }
        showToast(
          `${file.filename} — ${pluralize(playlist.tracks.length, 'трек', 'трека', 'треков')}`,
          'success'
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        showToast(`Не удалось выгрузить плейлист: ${detail}`, 'error');
      }
    },
    [close, playlist, showToast]
  );

  /** Просто текст «Исполнитель — Название»: чтобы отправить список в переписку. */
  const handleCopyList = useCallback(async () => {
    close(false);
    if (playlist.tracks.length === 0) {
      showToast('В плейлисте нет треков — копировать нечего', 'info');
      return;
    }

    const text = playlist.tracks
      .map((track, idx) => `${idx + 1}. ${track.artist || UNKNOWN_ARTIST} — ${track.title || UNKNOWN_TITLE}`)
      .join('\n');

    try {
      if (!navigator.clipboard?.writeText) throw new Error('буфер обмена недоступен');
      await navigator.clipboard.writeText(`${playlist.title}\n\n${text}`);
      showToast(`Список скопирован — ${pluralize(playlist.tracks.length, 'трек', 'трека', 'треков')}`, 'success');
    } catch {
      showToast('Скопировать не удалось — выгрузите файлом', 'error');
    }
  }, [close, playlist, showToast]);

  return (
    <div style={{ position: 'relative' }} ref={menuRef}>
      <button
        type="button"
        ref={triggerRef}
        className="press focus-ring"
        onClick={() => setIsOpen((open) => !open)}
        title="Вынести плейлист в файл"
        aria-label="Вынести плейлист в файл"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '36px',
          height: '36px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-subtle)',
          // `background: transparent` убран: <button> обнулён в ресете, а
          // инлайновое объявление было старше `.press:hover` — кнопка выгрузки
          // не отвечала на наведение. Подсветку «меню открыто» берёт на себя
          // `.press[aria-expanded='true']`.
          color: 'var(--text-secondary)',
          cursor: 'pointer'
        }}
        data-testid="playlist-export-btn"
      >
        <Share2 size={ICON.md} />
      </button>

      {isOpen && (
        <div
          className="panel-raised animate-drop-in"
          role="menu"
          aria-label="Куда вынести плейлист"
          style={{
            // Меню шире кнопки и выровнено по её правому краю, поэтому растёт из
            // правого верхнего угла: из центра оно раскрывалось бы мимо кнопки.
            '--pop-origin': 'top right',
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 'var(--space-1)',
            padding: 'var(--space-1)',
            minWidth: '260px',
            zIndex: 'var(--z-menu)'
          } as React.CSSProperties}
          data-testid="playlist-export-menu"
        >
          {FORMAT_ORDER.map((format, idx) => (
            <button
              type="button"
              role="menuitem"
              key={format}
              autoFocus={idx === 0}
              className="menu-item-hover"
              onClick={() => handleExport(format)}
              style={{ alignItems: 'flex-start' }}
              data-testid={`playlist-export-${format}`}
            >
              {FORMAT_ICON[format]}
              <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', textAlign: 'left' }}>
                <span>{EXPORT_FORMAT_LABELS[format]}</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  {EXPORT_FORMAT_HINTS[format]}
                </span>
              </span>
            </button>
          ))}

          <hr className="divider" style={{ margin: 'var(--space-1) 0' }} />

          <button
            type="button"
            role="menuitem"
            className="menu-item-hover"
            onClick={() => void handleCopyList()}
            data-testid="playlist-copy-list"
          >
            <ClipboardCopy size={ICON.md} aria-hidden="true" />
            <span className="text-truncate">Скопировать список текстом</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default PlaylistExportMenu;
