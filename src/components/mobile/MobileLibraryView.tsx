import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock,
  Download,
  Heart,
  HeartOff,
  Link2,
  ListMusic,
  ListPlus,
  Plus,
  Search as SearchIcon,
  Trash2,
  X
} from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { refusedForAccount, useUIStore } from '../../store/useUIStore';
import { offlineStorage } from '../../services/offlineStorage';
import { dedupeHistory } from '../library/trackSummary';
import { useVirtualRows, TRACK_ROW_PITCH } from '../../hooks/useVirtualRows';
import { ICON } from '../../styles/icons';
import { pluralize } from '../../utils/plural';
import type { UnifiedTrack } from '../../types/music';
import { ImportPlaylistModal } from '../modals/ImportPlaylistModal';
import { TrackRow } from './TrackRow';
import { TrackSelectionBar } from './TrackSelectionBar';
import { CoverCard } from '../common/CoverCard';
import { PlaylistCover } from '../library/PlaylistCover';
import { Sheet, SheetRow } from './Sheet';
import { offlineMode } from '../../services/offlineMode';

/**
 * Медиатека на телефоне.
 *
 * Что было не так. Один экран нёс четыре закладки-пилюли со счётчиками, под
 * ними панель из поля поиска, выпадающей сортировки и корзины — и только на
 * четвёртом этаже начинались треки: первый из них стоял на отметке 450 px из
 * 800. В каждой строке справа было **три** кнопки-иконки, из-за чего названию
 * доставалось 156 px и оно обрывалось на середине слова у половины треков.
 *
 * Здесь закладки остались (это разные списки, а не украшение), но панель
 * свернулась: поиск открывается значком и занимает место сортировки, которая
 * на телефоне почти не нужна — списки и так идут свежими сверху.
 */

type LibraryTab = 'recent' | 'favorites' | 'playlists' | 'offline';

interface TabItem {
  id: LibraryTab;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabItem[] = [
  { id: 'recent', label: 'Недавние', icon: <Clock size={ICON.md} /> },
  { id: 'favorites', label: 'Избранное', icon: <Heart size={ICON.md} /> },
  { id: 'playlists', label: 'Плейлисты', icon: <ListMusic size={ICON.md} /> },
  { id: 'offline', label: 'Офлайн', icon: <Download size={ICON.md} /> }
];

/** Какая закладка отвечает каждому маршруту. */
const TAB_FOR_VIEW: Partial<Record<string, LibraryTab>> = {
  library: 'recent',
  favorites: 'favorites',
  playlists: 'playlists',
  offline: 'offline'
};

const VIEW_FOR_TAB: Record<LibraryTab, 'library' | 'favorites' | 'playlists' | 'offline'> = {
  recent: 'library',
  favorites: 'favorites',
  playlists: 'playlists',
  offline: 'offline'
};

function matchesQuery(track: UnifiedTrack, needle: string): boolean {
  if (!needle) return true;
  return track.title.toLowerCase().includes(needle) || track.artist.toLowerCase().includes(needle);
}

export interface MobileLibraryViewProps {
  onCreatePlaylistClick?: () => void;
}

export const MobileLibraryView: React.FC<MobileLibraryViewProps> = ({ onCreatePlaylistClick }) => {
  const playlists = useLibraryStore((s) => s.playlists);
  const favorites = useLibraryStore((s) => s.favorites);
  const history = useLibraryStore((s) => s.history);

  const playTrack = usePlayerStore((s) => s.playTrack);
  const currentTrack = usePlayerStore((s) => s.currentTrack);

  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setActivePlaylistId = useUIStore((s) => s.setActivePlaylistId);
  const openTrackActions = useUIStore((s) => s.openTrackActions);

  const selectedIds = useUIStore((s) => s.selectedTrackIds);
  const toggleSelected = useUIStore((s) => s.toggleSelected);
  const clearSelection = useUIStore((s) => s.clearSelection);
  const showToast = useUIStore((s) => s.showToast);
  const addTrackToPlaylist = useLibraryStore((s) => s.addTrackToPlaylist);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);

  const [isMoveOpen, setMoveOpen] = useState(false);
  const [isSearchOpen, setSearchOpen] = useState(false);
  const [isImportOpen, setImportOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [offlineTracks, setOfflineTracks] = useState<UnifiedTrack[]>([]);

  const tab = TAB_FOR_VIEW[activeView] ?? 'recent';
  const needle = query.trim().toLowerCase();

  useEffect(() => {
    let alive = true;
    const read = () => {
      offlineStorage
        .getOfflineTracks()
        .then((rows) => {
          // Экрану нужны сами треки, а не записи хранилища с блобами.
          if (alive) setOfflineTracks(rows.map((record) => record.track));
        })
        .catch(() => {
          if (alive) setOfflineTracks([]);
        });
    };
    read();
    const unsubscribe = offlineStorage.subscribe(read);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const recent = useMemo(() => dedupeHistory(history), [history]);

  const tracks = useMemo(() => {
    const source =
      tab === 'favorites' ? favorites : tab === 'offline' ? offlineTracks : recent;
    return source.filter((track) => matchesQuery(track, needle));
  }, [favorites, needle, offlineTracks, recent, tab]);

  const visiblePlaylists = useMemo(
    () =>
      needle
        ? playlists.filter(
            (playlist) =>
              playlist.title.toLowerCase().includes(needle) ||
              playlist.tracks.some((track) => matchesQuery(track, needle))
          )
        : playlists,
    [needle, playlists]
  );

  // История копится годами: в разметке держим только видимую часть.
  const virtual = useVirtualRows({ itemCount: tracks.length, rowPitch: TRACK_ROW_PITCH });


  const selectedTracks = useMemo(
    () => (selectedIds ? tracks.filter((track) => selectedIds.includes(track.id)) : []),
    [selectedIds, tracks]
  );

  const handleSaveSelected = useCallback(async () => {
    if (selectedTracks.length === 0) return;
    const added = await offlineMode.queueTracks(selectedTracks).catch(() => 0);
    showToast(
      added > 0
        ? `${pluralize(added, 'трек', 'трека', 'треков')} в очереди на сохранение`
        : 'Всё выбранное уже сохранено',
      added > 0 ? 'success' : 'info'
    );
    clearSelection();
  }, [clearSelection, selectedTracks, showToast]);

  const handleMoveSelected = useCallback(
    async (targetId: string) => {
      if (selectedTracks.length === 0) return;
      // Считаем удачи, а не длину списка: пополнение отказывает без аккаунта,
      // и отчёт по длине отправил бы человека искать треки в чужом плейлисте.
      let moved = 0;
      for (const track of selectedTracks) {
        if (await addTrackToPlaylist(targetId, track)) moved += 1;
      }
      setMoveOpen(false);
      if (moved === 0) {
        if (!refusedForAccount()) showToast('Не удалось перенести треки', 'error');
        return;
      }
      const target = playlists.find((item) => item.id === targetId);
      showToast(
        `${pluralize(moved, 'трек', 'трека', 'треков')} в «${target?.title ?? 'плейлист'}»`,
        'success'
      );
      clearSelection();
    },
    [addTrackToPlaylist, clearSelection, playlists, selectedTracks, showToast]
  );

  const handleUnfavouriteSelected = useCallback(async () => {
    if (selectedTracks.length === 0) return;
    let removed = 0;
    for (const track of selectedTracks) {
      if (await toggleFavorite(track)) removed += 1;
    }
    if (removed === 0) {
      if (!refusedForAccount()) showToast('Не удалось убрать из избранного', 'error');
      return;
    }
    showToast(`Убрано из избранного: ${pluralize(removed, 'трек', 'трека', 'треков')}`, 'success');
    clearSelection();
  }, [clearSelection, selectedTracks, showToast, toggleFavorite]);

  const handleDeleteOfflineSelected = useCallback(async () => {
    if (selectedTracks.length === 0) return;
    for (const track of selectedTracks) {
      await offlineStorage.deleteOfflineTrack(track.id).catch(() => undefined);
    }
    showToast(
      `Удалено с устройства: ${pluralize(selectedTracks.length, 'трек', 'трека', 'треков')}`,
      'success'
    );
    clearSelection();
  }, [clearSelection, selectedTracks, showToast]);

  const openPlaylist = useCallback(
    (id: string) => {
      setActivePlaylistId(id);
      setActiveView('playlist');
    },
    [setActiveView, setActivePlaylistId]
  );

  const counts: Record<LibraryTab, number> = {
    recent: recent.length,
    favorites: favorites.length,
    playlists: playlists.length,
    offline: offlineTracks.length
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }} data-testid="mobile-library">
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        {isSearchOpen ? (
          <>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="В медиатеке"
              aria-label="Поиск по медиатеке"
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: '44px',
                padding: '0 var(--space-3)',
                borderRadius: 'var(--radius-pill)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
                fontSize: 'var(--text-base)'
              }}
              data-testid="mobile-library-search-input"
            />
            <IconButton
              label="Закрыть поиск"
              onClick={() => {
                setQuery('');
                setSearchOpen(false);
              }}
              testId="mobile-library-search-close"
            >
              <X size={ICON.lg} aria-hidden="true" />
            </IconButton>
          </>
        ) : (
          <>
            <h1
              style={{
                margin: 0,
                flex: 1,
                minWidth: 0,
                fontSize: 'var(--text-2xl)',
                lineHeight: 'var(--leading-2xl)',
                letterSpacing: 'var(--tracking-2xl)',
                fontWeight: 'var(--weight-bold)',
                color: 'var(--text-primary)'
              }}
            >
              Медиатека
            </h1>
            {tab === 'playlists' && (
              <>
                {/*
                  * Перенос плейлиста из другого сервиса. Приложение умеет это
                  * с самого начала — Spotify, Яндекс Музыка, VK, Apple Music,
                  * по ссылке, — но на телефоне кнопки не было ни одной, и
                  * возможность существовала только на ПК.
                  */}
                <IconButton
                  label="Перенести плейлист по ссылке"
                  onClick={() => setImportOpen(true)}
                  testId="mobile-library-import"
                >
                  <Link2 size={ICON.lg} aria-hidden="true" />
                </IconButton>
                {onCreatePlaylistClick && (
                  <IconButton label="Новый плейлист" onClick={onCreatePlaylistClick} testId="mobile-library-create">
                    <Plus size={ICON.lg} aria-hidden="true" />
                  </IconButton>
                )}
              </>
            )}
            <IconButton
              label="Искать в медиатеке"
              onClick={() => setSearchOpen(true)}
              testId="mobile-library-search-open"
            >
              <SearchIcon size={ICON.lg} aria-hidden="true" />
            </IconButton>
          </>
        )}
      </header>

      {/*
        * Закладки полкой с прокруткой, а не сеткой в два ряда: четыре пилюли со
        * счётчиками в 328 px не помещались и переносились, съедая ещё этаж.
        */}
      <div
        className="scroll-x-quiet"
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          overflowX: 'auto',
          margin: '0 calc(var(--space-4) * -1)',
          padding: '0 var(--space-4)'
        }}
      >
        {TABS.map((item) => {
          const isActive = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className="chip press"
              aria-pressed={isActive}
              onClick={() => setActiveView(VIEW_FOR_TAB[item.id])}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                flexShrink: 0,
                minHeight: '38px',
                padding: '0 var(--space-3)',
                borderRadius: 'var(--radius-pill)',
                cursor: 'pointer'
              }}
              data-testid={`mobile-library-tab-${item.id}`}
            >
              {item.icon}
              {item.label}
              {counts[item.id] > 0 && (
                <span style={{ color: 'var(--text-faint)' }}>{counts[item.id]}</span>
              )}
            </button>
          );
        })}
      </div>

      {/*
        * Действия зависят от закладки: из избранного убирают сердечко, из
        * офлайна — файл с устройства, а из недавнего убирать нечего — история
        * чистится целиком в настройках.
        */}
      <TrackSelectionBar
        total={tracks.length}
        allIds={tracks.map((track) => track.id)}
        testId="mobile-library-selection"
        actions={[
          {
            icon: <ListPlus size={ICON.md} aria-hidden="true" />,
            label: 'В плейлист',
            onClick: () => setMoveOpen(true),
            testId: 'mobile-library-selection-move'
          },
          {
            icon: <Download size={ICON.md} aria-hidden="true" />,
            label: 'Скачать',
            onClick: () => void handleSaveSelected(),
            testId: 'mobile-library-selection-save'
          },
          ...(tab === 'favorites'
            ? [
                {
                  icon: <HeartOff size={ICON.md} aria-hidden="true" />,
                  // «Из избранного» не влезало в 92 px кнопки и обрезалось;
                  // рядом уже стоит закладка «Избранное», так что откуда
                  // убирают — видно и без второго упоминания.
                  label: 'Убрать',
                  onClick: () => void handleUnfavouriteSelected(),
                  testId: 'mobile-library-selection-unfavourite'
                }
              ]
            : []),
          ...(tab === 'offline'
            ? [
                {
                  icon: <Trash2 size={ICON.md} aria-hidden="true" />,
                  label: 'С устройства',
                  onClick: () => void handleDeleteOfflineSelected(),
                  testId: 'mobile-library-selection-delete-offline'
                }
              ]
            : [])
        ]}
      />

      {tab === 'playlists' ? (
        visiblePlaylists.length === 0 ? (
          <Empty
            text={
              needle
                ? 'Ничего не нашлось'
                : 'Плейлистов пока нет. Соберите первый — треки добавляются из листа действий.'
            }
          />
        ) : (
          /*
            * Сетка обложек, а не строки со значком-заглушкой.
            *
            * Плейлист узнают по картинке: в списке из восьми строк с одним и
            * тем же серым значком приходится читать каждое название. Обложка
            * берётся своя, если её поставили, иначе складывается мозаикой из
            * состава — и то и другое различается с одного взгляда.
            */
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 'var(--space-4)'
            }}
          >
            {visiblePlaylists.map((playlist) => (
              <CoverCard
                key={playlist.id}
                title={playlist.title}
                subtitle={pluralize(playlist.tracks.length, 'трек', 'трека', 'треков')}
                cover={
                  <PlaylistCover
                    tracks={playlist.tracks}
                    coverUrl={playlist.coverUrl}
                    size="100%"
                    radius="var(--radius-lg)"
                  />
                }
                testId={`mobile-library-playlist-${playlist.id}`}
                onClick={() => openPlaylist(playlist.id)}
              />
            ))}
          </div>
        )
      ) : tracks.length === 0 ? (
        <Empty
          text={
            needle
              ? 'Ничего не нашлось'
              : tab === 'favorites'
                ? 'Избранного пока нет. Сердце — в листе действий над треком.'
                : tab === 'offline'
                  ? 'Офлайн пока пусто. Сюда попадает то, что вы слушали.'
                  : 'Здесь появится то, что вы слушали.'
          }
        />
      ) : (
        <div ref={virtual.containerRef} style={{ paddingTop: virtual.paddingTop, paddingBottom: virtual.paddingBottom }}>
          {tracks.slice(virtual.startIndex, virtual.endIndex).map((track, offset) => {
            const index = virtual.startIndex + offset;
            return (
              <TrackRow
                key={`${track.id}-${index}`}
                track={track}
                isCurrent={currentTrack?.id === track.id}
                onPlay={() => void playTrack(track, tracks, index)}
                onOpenActions={() => openTrackActions(track)}
                isSelectable={selectedIds !== null}
                isSelected={selectedIds?.includes(track.id) ?? false}
                onToggleSelect={() => toggleSelected(track.id)}
                data-testid={`mobile-library-track-${track.id}`}
              />
            );
          })}
        </div>
      )}

      <Sheet
        isOpen={isMoveOpen}
        onClose={() => setMoveOpen(false)}
        title={`В какой плейлист — ${selectedTracks.length}`}
        data-testid="mobile-library-move-sheet"
      >
        {playlists.length === 0 ? (
          <p
            style={{
              margin: 0,
              padding: 'var(--space-4)',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-muted)'
            }}
            data-testid="mobile-library-move-empty"
          >
            Плейлистов пока нет. Создайте его на закладке «Плейлисты».
          </p>
        ) : (
          playlists.map((item) => (
            <SheetRow
              key={item.id}
              icon={<ListPlus size={ICON.lg} aria-hidden="true" />}
              label={item.title}
              hint={pluralize(item.tracks.length, 'трек', 'трека', 'треков')}
              onClick={() => void handleMoveSelected(item.id)}
              data-testid={`mobile-library-move-${item.id}`}
            />
          ))
        )}
      </Sheet>

      <ImportPlaylistModal isOpen={isImportOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
};

const IconButton: React.FC<{
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  testId: string;
}> = ({ label, onClick, children, testId }) => (
  <button
    type="button"
    className="press focus-ring"
    onClick={onClick}
    aria-label={label}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '44px',
      height: '44px',
      flexShrink: 0,
      borderRadius: 'var(--radius-pill)',
      color: 'var(--text-secondary)',
      cursor: 'pointer'
    }}
    data-testid={testId}
  >
    {children}
  </button>
);

const Empty: React.FC<{ text: string }> = ({ text }) => (
  <p
    style={{
      margin: 0,
      padding: 'var(--space-5) 0',
      fontSize: 'var(--text-sm)',
      lineHeight: 'var(--leading-sm)',
      letterSpacing: 'var(--tracking-sm)',
      color: 'var(--text-muted)'
    }}
    data-testid="mobile-library-empty"
  >
    {text}
  </p>
);
