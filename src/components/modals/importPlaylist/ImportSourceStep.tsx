import React, { useRef } from 'react';
import { Loader2, ArrowRight, Upload } from 'lucide-react';
import type { PlatformType } from '../../../services/playlistImporter';
import { Button } from '../../common/Button';
import { ICON } from '../../../styles/icons';
import { LINK_PLATFORMS } from './platforms';
import { DetectedPlatformBadge, PlatformChip } from './PlatformBadges';

interface Props {
  url: string;
  detectedPlatform: PlatformType | null;
  isLoading: boolean;
  onUrlChange: (value: string) => void;
  onSubmit: (e?: React.FormEvent) => void;
  onFileChosen: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClose: () => void;
}

/** Первый шаг: ссылка на плейлист или файл с диска. */
export const ImportSourceStep: React.FC<Props> = ({
  url,
  detectedPlatform,
  isLoading,
  onUrlChange,
  onSubmit,
  onFileChosen,
  onClose
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <form onSubmit={onSubmit} className="stack gap-4">
      <div>
        <label
          htmlFor="import-url-input"
          className="block text-sm weight-medium text-secondary mb-2"
        >
          Ссылка на плейлист или альбом
        </label>
        <div className="relative row">
          <input
            id="import-url-input"
            type="url"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://open.spotify.com/playlist/… либо Яндекс Музыка, VK, Apple Music, YouTube, SoundCloud"
            autoFocus
            className="w-full" style={{ paddingRight: detectedPlatform ? '140px' : 'var(--space-3)' }}
            data-testid="import-url-input"
          />

          {detectedPlatform && <DetectedPlatformBadge platform={detectedPlatform} />}
        </div>
      </div>

      {/* Площадки, откуда переносим по ссылке */}
      <div>
        <div className="text-xs text-muted mb-2">
          Откуда можно переносить:
        </div>
        <div className="row-stretch wrap gap-2">
          {LINK_PLATFORMS.map((p) => (
            <PlatformChip key={p} platform={p} isMatch={detectedPlatform === p} />
          ))}
        </div>
      </div>

      {/* Файл плейлиста — второй способ переноса */}
      <div
        className="row justify-between gap-3 p-3 radius-md bg-surface-2" style={{ border: '1px dashed var(--border-subtle)' }}
      >
        <div className="min-0">
          <div className="text-sm text-primary weight-medium">
            Или откройте файл плейлиста
          </div>
          <div className="text-xs text-muted mt-px">
            Wireon Sounds (.json), .m3u8 из другого плеера, таблица .csv
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Upload size={ICON.sm} />}
          onClick={() => fileInputRef.current?.click()}
          data-testid="import-file-btn"
        >
          Выбрать файл
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.m3u,.m3u8,.csv,.txt,application/json,text/csv,text/plain,audio/x-mpegurl"
          onChange={(e) => void onFileChosen(e)}
          style={{ display: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
          data-testid="import-file-input"
        />
      </div>

      <div className="row-stretch justify-end gap-3 mt-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Отмена
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={isLoading || !url.trim()}
          icon={isLoading ? <Loader2 size={ICON.md} className="animate-spin" /> : <ArrowRight size={ICON.md} />}
          data-testid="fetch-playlist-btn"
        >
          {isLoading ? 'Читаем…' : 'Разобрать ссылку'}
        </Button>
      </div>
    </form>
  );
};
