import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FolderPlus,
  Heart,
  ListMusic,
  ListPlus,
  Music2,
  Plus,
  Radio,
  User
} from 'lucide-react';
import type { UnifiedTrack } from '../../types/music';
import { ICON } from '../../styles/icons';
import { pluralize } from '../../utils/plural';
import { Sheet, SheetRow } from './Sheet';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore, refusedForAccount } from '../../store/useUIStore';
import { offlineStorage } from '../../services/offlineStorage';

/**
 * Действия над треком — листом снизу вместо выпадающего меню.
 *
 * Чем было плохо прежнее меню (`TrackCard.tsx`, выпадающий блок):
 *
 * - `position: absolute` внутри `<main>` с `overflow: auto` — слой **обрезался
 *   контейнером**, и `z-index: 1000` этого не менял;
 * - `top: 100%` без переворота вверх: у строки на нижней половине экрана меню
 *   уезжало под полосу плеера и нижнюю панель;
 * - `right: 0` и ширина 210 px — блок висел в правом углу, куда большой палец
 *   дотягивается последним. Отсюда «не влезает или не по центру»;
 * - весь список плейлистов сыпался в то же меню, поэтому при десяти плейлистах
 *   внутри обрезанного меню появлялась ещё и своя прокрутка.
 *
 * Лист не имеет ни одной из этих болезней: он прибит к окну, растёт вверх от
 * нижнего края и занимает всю ширину. Плейлисты вынесены во **второй** лист —
 * первый остаётся коротким и предсказуемым независимо от того, сколько у
 * человека плейлистов.
 */

export interface TrackActionsSheetProps {
  track: UnifiedTrack | null;
  onClose: () => void;
}

const SOURCE_LABELS: Record<string, string> = {
  youtube: 'YouTube',
  soundcloud: 'SoundCloud'
};

/** Открывает страницу источника в системном браузере. */
function openSourceUrl(url: string): void {
  const bridge = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (bridge && typeof bridge.openExternal === 'function') {
    void Promise.resolve(bridge.openExternal(url)).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export const TrackActionsSheet: React.FC<TrackActionsSheetProps> = ({ track, onClose }) => {
  const [isPlaylistPickerOpen, setPlaylistPickerOpen] = useState(false);
  const [artworkFailed, setArtworkFailed] = useState(false);
  const [isSaved, setSaved] = useState(false);
  const [savingPct, setSavingPct] = useState<number | null>(null);

  /*
   * Состояние офлайна читается при каждом открытии листа и обновляется по
   * подписке: трек могло сохранить фоновое кэширование, пока лист был закрыт,
   * и предлагать «Скачать» уже сохранённому — врать.
   */
  useEffect(() => {
    if (!track) return;
    let alive = true;
    const read = () => {
      offlineStorage
        .isDownloaded(track.id)
        .then((yes) => {
          if (alive) setSaved(yes);
        })
        .catch(() => {});
    };
    read();
    const unsubscribe = offlineStorage.subscribe(read);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [track]);

  const addToQueueEnd = usePlayerStore((s) => s.addToQueueEnd);
  const addToQueueNext = usePlayerStore((s) => s.addToQueueNext);

  const isFavorite = useLibraryStore((s) => (track ? s.isFavorite(track.id) : false));
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  const playlists = useLibraryStore((s) => s.playlists);
  const addTrackToPlaylist = useLibraryStore((s) => s.addTrackToPlaylist);

  const showToast = useUIStore((s) => s.showToast);
  const openArtist = useUIStore((s) => s.openArtist);

  const close = useCallback(() => {
    setPlaylistPickerOpen(false);
    setArtworkFailed(false);
    onClose();
  }, [onClose]);

  const handlePlayNext = useCallback(() => {
    if (!track) return;
    addToQueueNext(track);
    showToast(`«${track.title}» прозвучит следующим`, 'info');
    close();
  }, [addToQueueNext, close, showToast, track]);

  const handleQueueEnd = useCallback(() => {
    if (!track) return;
    addToQueueEnd(track);
    showToast(`«${track.title}» добавлен в очередь`, 'info');
    close();
  }, [addToQueueEnd, close, showToast, track]);

  const handleRadio = useCallback(() => {
    if (!track) return;
    void usePlayerStore.getState().startTrackRadio(track);
    showToast(`Радио по треку «${track.title}»`, 'success');
    close();
  }, [close, showToast, track]);

  const handleFavorite = useCallback(async () => {
    if (!track) return;
    const wasFavorite = isFavorite;
    const ok = await toggleFavorite(track);
    if (!ok) {
      if (refusedForAccount()) return;
      showToast(useLibraryStore.getState().error || 'Не удалось обновить избранное', 'error');
      return;
    }
    showToast(
      wasFavorite ? `«${track.title}» убран из избранного` : `«${track.title}» в избранном`,
      'success'
    );
    close();
  }, [close, isFavorite, showToast, toggleFavorite, track]);

  const handleDownload = useCallback(async () => {
    if (!track) return;
    setSavingPct(0);
    try {
      await offlineStorage.downloadTrack(track, (pct) => setSavingPct(pct));
      setSaved(true);
      showToast(`«${track.title}» сохранён для офлайна`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Скачать не удалось', 'error');
    } finally {
      setSavingPct(null);
    }
  }, [showToast, track]);

  const handleRemoveDownload = useCallback(async () => {
    if (!track) return;
    try {
      await offlineStorage.deleteOfflineTrack(track.id);
      setSaved(false);
      showToast(`«${track.title}» убран из офлайна`, 'info');
    } catch {
      showToast('Удалить из офлайна не удалось', 'error');
    }
  }, [showToast, track]);

  const handleArtist = useCallback(() => {
    if (!track?.artist) return;
    openArtist(track.artist);
    close();
  }, [close, openArtist, track]);

  const handleOpenSource = useCallback(() => {
    if (track?.sourceUrl) openSourceUrl(track.sourceUrl);
    close();
  }, [close, track]);

  const handleAddToPlaylist = useCallback(
    async (playlistId: string, playlistTitle: string) => {
      if (!track) return;
      const ok = await addTrackToPlaylist(playlistId, track);
      if (!ok) {
        if (refusedForAccount()) return;
        showToast(useLibraryStore.getState().error || 'Не удалось добавить трек в плейлист', 'error');
        return;
      }
      showToast(`«${track.title}» добавлен в «${playlistTitle}»`, 'success');
      close();
    },
    [addTrackToPlaylist, close, showToast, track]
  );

  if (!track) return null;

  const sourceLabel = SOURCE_LABELS[track.source] ?? track.source;

  /* Шапка листа: по ней видно, о каком именно треке идёт речь. Прежнее меню
   * этого не говорило вовсе — открыв его с середины длинного списка, человек
   * мог только помнить, на что нажал. */
  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
      <span
        style={{
          width: '56px',
          height: '56px',
          flexShrink: 0,
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
          background: 'var(--surface-sunken)',
          border: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {artworkFailed || !track.artworkUrl ? (
          <Music2 size={ICON.lg} style={{ color: 'var(--text-faint)' }} aria-hidden="true" />
        ) : (
          <img
            src={track.artworkUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={() => setArtworkFailed(true)}
          />
        )}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: '2px' }}>
        <span
          className="text-truncate"
          style={{
            fontSize: 'var(--text-base)',
            lineHeight: 'var(--leading-base)',
            letterSpacing: 'var(--tracking-base)',
            fontWeight: 'var(--weight-semibold)',
            color: 'var(--text-primary)'
          }}
        >
          {track.title}
        </span>
        <span
          className="text-truncate"
          style={{
            fontSize: 'var(--text-sm)',
            lineHeight: 'var(--leading-sm)',
            letterSpacing: 'var(--tracking-sm)',
            color: 'var(--text-muted)'
          }}
        >
          {track.artist}
        </span>
      </span>
    </div>
  );

  return (
    <>
      <Sheet
        isOpen={!isPlaylistPickerOpen}
        onClose={close}
        header={header}
        data-testid="track-actions-sheet"
        aria-label={`Действия с «${track.title}»`}
      >
        <SheetRow
          icon={<ListPlus size={ICON.lg} aria-hidden="true" />}
          label="Играть следующим"
          onClick={handlePlayNext}
          data-testid="track-actions-play-next"
        />
        <SheetRow
          icon={<Radio size={ICON.lg} aria-hidden="true" />}
          label="Радио по треку"
          hint="Бесконечный поток похожего"
          onClick={handleRadio}
          data-testid="track-actions-radio"
        />
        <SheetRow
          icon={<Plus size={ICON.lg} aria-hidden="true" />}
          label="В конец очереди"
          onClick={handleQueueEnd}
          data-testid="track-actions-queue-end"
        />
        <SheetRow
          icon={
            <Heart
              size={ICON.lg}
              fill={isFavorite ? 'currentColor' : 'none'}
              style={isFavorite ? { color: 'var(--danger)' } : undefined}
              aria-hidden="true"
            />
          }
          label={isFavorite ? 'Убрать из избранного' : 'В избранное'}
          onClick={() => void handleFavorite()}
          data-testid="track-actions-favorite"
        />
        {/*
          * Скачивание. Возможность сохранить трек на устройство в коде была с
          * самого начала, но позвать её было неоткуда: `downloadTrack` вызывал
          * только фоновый режим, который кэширует прослушанное сам. То есть
          * «скачать эту песню перед дорогой» сделать было нельзя.
          */}
        <SheetRow
          icon={
            isSaved ? (
              <Check size={ICON.lg} style={{ color: 'var(--success)' }} aria-hidden="true" />
            ) : (
              <Download size={ICON.lg} aria-hidden="true" />
            )
          }
          label={isSaved ? 'Убрать из офлайна' : savingPct === null ? 'Скачать' : 'Скачиваем…'}
          hint={
            savingPct !== null
              ? `${Math.round(savingPct)}%`
              : isSaved
                ? 'Лежит на устройстве'
                : 'Слушать без сети'
          }
          onClick={() => void (isSaved ? handleRemoveDownload() : handleDownload())}
          data-testid="track-actions-download"
        />

        {/*
          * Плейлисты — отдельным листом. В прежнем меню они сыпались списком
          * сюда же, и высота зависела от того, сколько их у человека.
          */}
        <SheetRow
          icon={<FolderPlus size={ICON.lg} aria-hidden="true" />}
          label="Добавить в плейлист"
          hint={
            playlists.length === 0
              ? 'Плейлистов пока нет'
              : pluralize(playlists.length, 'плейлист', 'плейлиста', 'плейлистов')
          }
          chevron={<ChevronRight size={ICON.md} aria-hidden="true" />}
          onClick={() => setPlaylistPickerOpen(true)}
          data-testid="track-actions-playlists"
        />
        {track.artist && (
          <SheetRow
            icon={<User size={ICON.lg} aria-hidden="true" />}
            label="Перейти к исполнителю"
            hint={track.artist}
            onClick={handleArtist}
            data-testid="track-actions-artist"
          />
        )}
        {track.sourceUrl && (
          <SheetRow
            icon={<ExternalLink size={ICON.lg} aria-hidden="true" />}
            label={`Открыть в ${sourceLabel}`}
            onClick={handleOpenSource}
            data-testid="track-actions-source"
          />
        )}
      </Sheet>

      <Sheet
        isOpen={isPlaylistPickerOpen}
        onClose={() => setPlaylistPickerOpen(false)}
        title="Добавить в плейлист"
        data-testid="track-playlists-sheet"
      >
        {playlists.length === 0 ? (
          <p
            style={{
              margin: 0,
              padding: 'var(--space-4)',
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              letterSpacing: 'var(--tracking-sm)',
              color: 'var(--text-muted)'
            }}
          >
            Плейлистов пока нет. Создайте первый в Медиатеке — трек можно будет добавить туда отсюда же.
          </p>
        ) : (
          playlists.map((playlist) => (
            <SheetRow
              key={playlist.id}
              icon={<ListMusic size={ICON.lg} aria-hidden="true" />}
              label={playlist.title}
              hint={pluralize(playlist.tracks.length, 'трек', 'трека', 'треков')}
              onClick={() => void handleAddToPlaylist(playlist.id, playlist.title)}
              data-testid={`track-playlists-item-${playlist.id}`}
            />
          ))
        )}
      </Sheet>
    </>
  );
};
