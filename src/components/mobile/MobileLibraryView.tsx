import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePinnedStore, orderPinned } from '../../store/usePinnedStore';
import { SmartPlaylistsShelf } from '../smart/SmartPlaylistsShelf';
import {
  Clock,
  Download,
  Folder,
  FolderMinus,
  FolderPlus,
  Heart,
  HeartOff,
  Link2,
  ListMusic,
  ListPlus,
  MoreHorizontal,
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
import { LibraryFilterChips } from '../library/LibraryFilterChips';
import { DuplicatesBanner } from '../library/DuplicatesBanner';
import { useLibraryFilters } from '../library/useLibraryFilters';
import { useVirtualRows, TRACK_ROW_PITCH } from '../../hooks/useVirtualRows';
import { ICON } from '../../styles/icons';
import { pluralize } from '../../utils/plural';
import type { UnifiedTrack } from '../../types/music';
import { ImportPlaylistModal } from '../modals/ImportPlaylistModal';
import { TrackRow } from './TrackRow';
import { TrackSelectionBar } from './TrackSelectionBar';
import { CoverCard } from '../common/CoverCard';
import { EmptyState, type EmptyStateAction } from '../common/EmptyState';
import type { EmptyArtName } from '../common/emptyArt';
import { PlaylistCover } from '../library/PlaylistCover';
import { Sheet, SheetRow } from './Sheet';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { FolderShelf } from '../library/FolderShelf';
import { FolderNameModal } from '../library/FolderNameModal';
import { useFolderStore, groupByFolders, folderOfPlaylist, PlaylistFolder } from '../../store/useFolderStore';
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
  const addTracksToPlaylist = useLibraryStore((s) => s.addTracksToPlaylist);
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

  // Те же чипы, что на компьютере; «Офлайн» и «Плейлисты» их не получают.
  const libraryFilters = useLibraryFilters();
  const showFilters = (tab === 'favorites' && favorites.length > 0) || (tab === 'recent' && recent.length > 0);

  const tracks = useMemo(() => {
    const source =
      tab === 'favorites' ? favorites : tab === 'offline' ? offlineTracks : recent;
    const found = source.filter((track) => matchesQuery(track, needle));
    if (tab === 'favorites') return libraryFilters.apply(found);
    if (tab === 'recent') return libraryFilters.apply(found, { allowStale: false });
    return found;
  }, [favorites, needle, offlineTracks, recent, tab, libraryFilters]);

  const pinnedIds = usePinnedStore((s) => s.pinnedIds);
  useEffect(() => {
    void usePinnedStore.getState().hydrate();
  }, []);
  const visiblePlaylists = useMemo(
    () =>
      orderPinned(
        needle
          ? playlists.filter(
              (playlist) =>
                playlist.title.toLowerCase().includes(needle) ||
                playlist.tracks.some((track) => matchesQuery(track, needle))
            )
          : playlists,
        pinnedIds
      ),
    [needle, playlists, pinnedIds]
  );

  /*
   * Папки — та же логика, что в медиатеке ПК (`LibraryView`), только компактнее:
   * полка карточек с прокруткой вбок, а «В папку…» — листом снизу вместо меню.
   */
  const folders = useFolderStore((s) => s.folders);
  useEffect(() => {
    void useFolderStore.getState().hydrate();
  }, []);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<{ mode: 'create' } | { mode: 'rename'; folder: PlaylistFolder } | null>(null);
  const [pendingFolderDelete, setPendingFolderDelete] = useState<PlaylistFolder | null>(null);
  /** Плейлист, для которого открыт лист «В папку…». */
  const [folderPickFor, setFolderPickFor] = useState<string | null>(null);
  useEffect(() => {
    if (openFolderId && !folders.some((f) => f.id === openFolderId)) setOpenFolderId(null);
  }, [folders, openFolderId]);
  const grouped = useMemo(() => groupByFolders(visiblePlaylists, folders), [visiblePlaylists, folders]);
  // При поиске — плоский список по всей медиатеке, папки не мешают.
  const showFolders = !needle && folders.length > 0;
  const openGroup = showFolders && openFolderId ? grouped.groups.find((g) => g.folder.id === openFolderId) ?? null : null;
  const gridPlaylists = !showFolders ? visiblePlaylists : openGroup ? openGroup.playlists : grouped.loose;
  const pickTarget = folderPickFor ? playlists.find((p) => p.id === folderPickFor) ?? null : null;
  const pickCurrentFolderId = folderPickFor ? folderOfPlaylist(folders, folderPickFor)?.id ?? null : null;

  const handleFolderSubmit = (title: string) => {
    if (!folderDialog) return;
    if (folderDialog.mode === 'create') {
      const id = useFolderStore.getState().createFolder(title);
      if (id) showToast(`Папка «${title}» создана`, 'success');
    } else {
      useFolderStore.getState().renameFolder(folderDialog.folder.id, title);
    }
  };

  const handlePickFolder = (folderId: string | null) => {
    if (folderPickFor && folderId !== pickCurrentFolderId) {
      useFolderStore.getState().moveToFolder(folderPickFor, folderId);
    }
    setFolderPickFor(null);
  };

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
      /*
       * Считаем удачи, а не длину списка: пополнение отказывает без аккаунта,
       * и отчёт по длине отправил бы человека искать треки в чужом плейлисте.
       * Пачка уходит одной записью, повторы пропускаются и называются.
       */
      const result = await addTracksToPlaylist(targetId, selectedTracks);
      const moved = result?.added ?? 0;
      const skipped = result?.skipped ?? 0;

      setMoveOpen(false);
      if (result && moved === 0 && skipped > 0) {
        showToast('Всё выбранное уже в этом плейлисте', 'info');
        clearSelection();
        return;
      }
      if (moved === 0) {
        if (!refusedForAccount()) showToast('Не удалось перенести треки', 'error');
        return;
      }
      const target = playlists.find((item) => item.id === targetId);
      showToast(
        `${pluralize(moved, 'трек', 'трека', 'треков')} в «${target?.title ?? 'плейлист'}»` +
          (skipped > 0 ? ` · повторы пропущены` : ''),
        'success'
      );
      clearSelection();
    },
    [addTracksToPlaylist, clearSelection, playlists, selectedTracks, showToast]
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
    <div className="stack gap-4" data-testid="mobile-library">
      <header className="row gap-2">
        {isSearchOpen ? (
          <>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="В медиатеке"
              aria-label="Поиск по медиатеке"
              className="grow text-primary text-base py-0 px-3 bg-surface-2 border-line" style={{ minHeight: '44px', borderRadius: 'var(--radius-pill)' }}
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
              className="m-0 grow weight-bold text-primary type-2xl"
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
                {playlists.length >= 2 && (
                  <IconButton label="Новая папка" onClick={() => setFolderDialog({ mode: 'create' })} testId="mobile-library-create-folder">
                    <FolderPlus size={ICON.lg} aria-hidden="true" />
                  </IconButton>
                )}
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
        className="scroll-x-quiet row-stretch gap-2"
        style={{ overflowX: 'auto', margin: '0 calc(var(--mobile-content-pad, var(--space-4)) * -1)', padding: '0 var(--mobile-content-pad, var(--space-4))' }}
      >
        {TABS.map((item) => {
          const isActive = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className="chip press row gap-2 shrink-0 pointer py-0 px-3"
              aria-pressed={isActive}
              onClick={() => setActiveView(VIEW_FOR_TAB[item.id])}
              style={{ minHeight: '38px', borderRadius: 'var(--radius-pill)' }}
              data-testid={`mobile-library-tab-${item.id}`}
            >
              {item.icon}
              {item.label}
              {counts[item.id] > 0 && (
                <span className="text-faint">{counts[item.id]}</span>
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

      {showFilters && (
        <LibraryFilterChips
          filters={libraryFilters.filters}
          onChange={libraryFilters.setFilters}
          count={tracks.length}
          scope={tab === 'favorites' ? 'favorites' : 'recent'}
          showStale={tab === 'favorites'}
        />
      )}

      {tab === 'favorites' && <DuplicatesBanner tracks={favorites} />}

      {tab === 'playlists' && !needle && (
        <div className="mb-5">
          <SmartPlaylistsShelf compact />
        </div>
      )}

      {tab === 'playlists' ? (
        visiblePlaylists.length === 0 ? (
          needle ? (
            <Empty
              art="search"
              title="Ничего не нашлось"
              text={`Ни один плейлист не подходит под «${query.trim()}».`}
              action={{ label: 'Сбросить поиск', onClick: () => setQuery('') }}
            />
          ) : (
            <Empty
              art="playlists"
              title="Здесь будут ваши плейлисты"
              text="Соберите первый, треки добавляются из листа действий."
              action={
                onCreatePlaylistClick
                  ? { label: 'Создать плейлист', onClick: onCreatePlaylistClick }
                  : { label: 'Найти треки', onClick: () => setActiveView('search') }
              }
            />
          )
        ) : (
          /*
            * Сетка обложек, а не строки со значком-заглушкой.
            *
            * Плейлист узнают по картинке: в списке из восьми строк с одним и
            * тем же серым значком приходится читать каждое название. Обложка
            * берётся своя, если её поставили, иначе складывается мозаикой из
            * состава — и то и другое различается с одного взгляда.
            */
          <div className="stack gap-4">
            {showFolders && (
              <FolderShelf
                compact
                groups={grouped.groups}
                openFolderId={openFolderId}
                onOpen={setOpenFolderId}
                onBack={() => setOpenFolderId(null)}
                onRename={(folder) => setFolderDialog({ mode: 'rename', folder })}
                onDelete={setPendingFolderDelete}
              />
            )}
            {showFolders && !openFolderId && gridPlaylists.length > 0 && (
              <h2 className="m-0 text-base weight-semibold text-secondary leading-base" data-testid="playlists-loose-heading">
                Остальные
              </h2>
            )}
            {gridPlaylists.length === 0 ? (
              openFolderId ? (
                <Empty
                  art="playlists"
                  title="В папке пока пусто"
                  text="Положите сюда плейлист кнопкой «…» на обложке."
                  action={{ label: 'Ко всем плейлистам', onClick: () => setOpenFolderId(null) }}
                />
              ) : (
                <p className="m-0 text-sm text-muted py-5 px-0 leading-sm tracking-sm" data-testid="mobile-library-empty">
                  Все плейлисты разложены по папкам.
                </p>
              )
            ) : (
          <div
            className="grid gap-4" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
          >
            {gridPlaylists.map((playlist) => (
              <div key={playlist.id} className="relative">
                <CoverCard
                  title={playlist.title}
                  subtitle={
                    (pinnedIds.includes(playlist.id) ? 'Закреплён · ' : '') +
                    pluralize(playlist.tracks.length, 'трек', 'трека', 'треков')
                  }
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
                {/* Кнопка «в папку» — поверх обложки: у карточки другого места для действий нет. */}
                {folders.length > 0 && (
                  <button
                    type="button"
                    className="folder-pick-btn press focus-ring pointer"
                    onClick={() => setFolderPickFor(playlist.id)}
                    aria-label={`Папка для «${playlist.title}»`}
                    data-testid={`mobile-playlist-folder-btn-${playlist.id}`}
                  >
                    <MoreHorizontal size={ICON.md} aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
            )}
          </div>
        )
      ) : tracks.length === 0 ? (
        needle ? (
          <Empty
            art="search"
            title="Ничего не нашлось"
            text={`Здесь нет ничего по запросу «${query.trim()}».`}
            action={{ label: 'Сбросить поиск', onClick: () => setQuery('') }}
          />
        ) : tab === 'favorites' ? (
          <Empty
            art="favorites"
            title="Здесь будут ваши любимые"
            text="Сердце есть в листе действий над треком."
            action={{ label: 'Найти что-нибудь', onClick: () => setActiveView('search') }}
          />
        ) : tab === 'offline' ? (
          <Empty
            art="offline"
            title="Здесь будет музыка без интернета"
            text="Включите офлайн-режим, и прослушанное останется на телефоне."
            action={{ label: 'Открыть настройки', onClick: () => setActiveView('settings') }}
          />
        ) : (
          <Empty
            art="history"
            title="Здесь появится то, что вы слушали"
            text="Включите любой трек или запустите Поток."
            action={{ label: 'Включить Поток', onClick: () => setActiveView('wave') }}
          />
        )
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
            className="m-0 p-4 text-sm text-muted"
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

      <Sheet
        isOpen={folderPickFor !== null}
        onClose={() => setFolderPickFor(null)}
        title={pickTarget ? `В папку — ${pickTarget.title}` : 'В папку'}
        data-testid="mobile-folder-pick-sheet"
      >
        {folders.map((folder) => (
          <SheetRow
            key={folder.id}
            icon={<Folder size={ICON.lg} aria-hidden="true" />}
            label={folder.title}
            hint={folder.id === pickCurrentFolderId ? 'Уже здесь' : pluralize(folder.playlistIds.length, 'плейлист', 'плейлиста', 'плейлистов')}
            onClick={() => handlePickFolder(folder.id)}
            data-testid={`mobile-folder-pick-${folder.id}`}
          />
        ))}
        <SheetRow
          icon={<FolderMinus size={ICON.lg} aria-hidden="true" />}
          label="Без папки"
          hint={pickCurrentFolderId === null ? 'Сейчас так' : undefined}
          onClick={() => handlePickFolder(null)}
          data-testid="mobile-folder-pick-none"
        />
      </Sheet>

      <FolderNameModal
        isOpen={folderDialog !== null}
        initialTitle={folderDialog?.mode === 'rename' ? folderDialog.folder.title : ''}
        onClose={() => setFolderDialog(null)}
        onSubmit={handleFolderSubmit}
      />

      <ConfirmDialog
        isOpen={pendingFolderDelete !== null}
        title={pendingFolderDelete ? `Удалить папку «${pendingFolderDelete.title}»?` : 'Удалить папку?'}
        description="Плейлисты останутся в медиатеке — они просто выйдут из папки."
        confirmLabel="Удалить папку"
        danger
        onConfirm={() => {
          if (pendingFolderDelete) useFolderStore.getState().deleteFolder(pendingFolderDelete.id);
          setPendingFolderDelete(null);
        }}
        onCancel={() => setPendingFolderDelete(null)}
      />
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
    className="press focus-ring row justify-center shrink-0 text-secondary pointer"
    onClick={onClick}
    aria-label={label}
    style={{ width: '44px', height: '44px', borderRadius: 'var(--radius-pill)' }}
    data-testid={testId}
  >
    {children}
  </button>
);

/** Пустая вкладка медиатеки: рисунок, что здесь будет, и одно действие. */
const Empty: React.FC<{ art: EmptyArtName; title: string; text: string; action: EmptyStateAction }> = ({
  art,
  title,
  text,
  action
}) => <EmptyState art={art} title={title} description={text} action={action} data-testid="mobile-library-empty" />;
