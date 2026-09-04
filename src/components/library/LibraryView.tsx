import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ListMusic,
  Heart,
  History,
  Plus,
  Play,
  RotateCcw,
  Search,
  Trash2,
  Clock,
  Disc,
  HardDrive,
  Import
} from 'lucide-react';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { Button } from '../common/Button';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { EmptyState } from '../common/EmptyState';
import { Skeleton } from '../common/Skeleton';
import { TrackCard } from '../search/TrackCard';
import { FavoritesView } from './FavoritesView';
import { PlaylistCover } from './PlaylistCover';
import { OfflineSection } from './OfflineSection';
import { offlineStorage } from '../../services/offlineStorage';
import { UnifiedTrack } from '../../types/music';
import { describeTrackTotals, dedupeHistory } from './trackSummary';
import { useVirtualRows, TRACK_ROW_PITCH } from '../../hooks/useVirtualRows';
import { useMediaQuery } from '../../hooks/useMediaQuery';

import { ImportPlaylistModal } from '../modals/ImportPlaylistModal';
import { ICON } from '../../styles/icons';

export interface LibraryViewProps {
  onCreatePlaylistClick?: () => void;
  onImportPlaylistClick?: () => void;
  className?: string;
}

type LibraryTab = 'library' | 'favorites' | 'playlists' | 'offline';
type SortMode = 'recent' | 'title' | 'duration';

interface TabDescriptor {
  tab: LibraryTab;
  label: string;
  icon: React.ReactNode;
  testId: string;
}

const TABS: TabDescriptor[] = [
  { tab: 'library', label: 'Недавние', icon: <History size={ICON.md} aria-hidden="true" />, testId: 'tab-library' },
  { tab: 'favorites', label: 'Избранное', icon: <Heart size={ICON.md} aria-hidden="true" />, testId: 'tab-favorites' },
  { tab: 'playlists', label: 'Плейлисты', icon: <ListMusic size={ICON.md} aria-hidden="true" />, testId: 'tab-playlists' },
  // Скачивания по одному треку больше нет — вкладка про то, что доступно без сети.
  { tab: 'offline', label: 'Офлайн', icon: <HardDrive size={ICON.md} aria-hidden="true" />, testId: 'tab-offline' }
];

const SORT_LABELS: Record<SortMode, string> = {
  recent: 'Сначала недавние',
  title: 'По названию (А–Я)',
  duration: 'Сначала длинные'
};

/**
 * Те же режимы, но короче — для телефона.
 *
 * Ширину `select` задаёт самый длинный вариант списка, и «По названию (А–Я)»
 * забирал половину строки: поиск сжимался до нечитаемого, а корзина уезжала на
 * вторую строку. Слово «Сортировка» на телефоне и так убрано, поэтому подписи
 * обязаны говорить сами за себя и в коротком виде.
 */
const SORT_LABELS_SHORT: Record<SortMode, string> = {
  recent: 'Недавние',
  title: 'А–Я',
  duration: 'Длинные'
};

function matchesQuery(track: UnifiedTrack, needle: string): boolean {
  if (!needle) return true;
  return (
    track.title.toLowerCase().includes(needle) || track.artist.toLowerCase().includes(needle)
  );
}

/** `recent` keeps the order the store provides — both lists are already newest-first. */
function sortTracks(tracks: UnifiedTrack[], mode: SortMode): UnifiedTrack[] {
  if (mode === 'recent') return tracks;

  const copy = [...tracks];
  if (mode === 'title') {
    copy.sort((a, b) => a.title.localeCompare(b.title));
    return copy;
  }

  // Unknown durations sort last rather than pretending to be 0 seconds.
  copy.sort((a, b) => {
    const left = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : -1;
    const right = Number.isFinite(b.duration) && b.duration > 0 ? b.duration : -1;
    return right - left;
  });
  return copy;
}

/**
 * One view for the three library destinations. The selected tab is derived from
 * `activeView`, so the sidebar, the header and the tab strip can never disagree.
 */
export const LibraryView: React.FC<LibraryViewProps> = ({
  onCreatePlaylistClick,
  onImportPlaylistClick,
  className = ''
}) => {
  /*
   * На телефоне медиатека — самый переполненный экран приложения. Замерено на
   * эмуляторе 2026-08-28 при 360x800: до первой строки трека уходило около
   * 900 пикселей, то есть больше экрана, и список начинался за краем. Съедали
   * его четыре яруса подряд: закладки, заголовок раздела в две строки,
   * подпись со счётчиком и ряд «поиск + сортировка».
   *
   * Заголовок и подпись здесь лишние вдвойне: выбранная закладка уже написана
   * прямо над ними, и счётчик в ней тот же самый. В телефонных плеерах
   * повторного названия раздела нет — сразу список.
   */
  const isNarrow = useMediaQuery('(max-width: 768px)');

  const playlists = useLibraryStore((s) => s.playlists);
  const favorites = useLibraryStore((s) => s.favorites);
  const history = useLibraryStore((s) => s.history);
  const isLoading = useLibraryStore((s) => s.isLoading);
  const clearHistory = useLibraryStore((s) => s.clearHistory);
  const deletePlaylist = useLibraryStore((s) => s.deletePlaylist);

  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setActivePlaylistId = useUIStore((s) => s.setActivePlaylistId);
  const showToast = useUIStore((s) => s.showToast);

  const playTrack = usePlayerStore((s) => s.playTrack);

  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);
  const [isClearingHistory, setIsClearingHistory] = useState(false);
  const [offlineCount, setOfflineCount] = useState(0);
  const [localTab, setLocalTab] = useState<LibraryTab>('library');
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  const tablistRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updateOfflineCount = () => {
      void offlineStorage.getTotalStorageUsed().then((info) => setOfflineCount(info.count));
    };
    updateOfflineCount();
    const unsubscribe = offlineStorage.subscribe(updateOfflineCount);
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (activeView === 'favorites') setLocalTab('favorites');
    else if (activeView === 'playlists') setLocalTab('playlists');
    else if (activeView === 'offline' || (activeView as string) === 'downloaded') setLocalTab('offline');
    else if (activeView === 'library') setLocalTab('library');
  }, [activeView]);

  const activeTab: LibraryTab =
    activeView === 'favorites'
      ? 'favorites'
      : activeView === 'playlists'
      ? 'playlists'
      : activeView === 'offline' || (activeView as string) === 'downloaded'
      ? 'offline'
      : localTab;

  const needle = query.trim().toLowerCase();

  const recentlyPlayed = useMemo(() => dedupeHistory(history), [history]);

  const visibleHistory = useMemo(
    () => sortTracks(recentlyPlayed.filter((t) => matchesQuery(t, needle)), sortMode),
    [recentlyPlayed, needle, sortMode]
  );

  // История копится годами — в DOM держим только видимую часть.
  const historyVirtual = useVirtualRows({
    itemCount: visibleHistory.length,
    rowPitch: TRACK_ROW_PITCH
  });

  const visibleFavorites = useMemo(
    () => sortTracks(favorites.filter((t) => matchesQuery(t, needle)), sortMode),
    [favorites, needle, sortMode]
  );

  const visiblePlaylists = useMemo(
    () =>
      needle
        ? playlists.filter(
            (pl) =>
              pl.title.toLowerCase().includes(needle) ||
              pl.tracks.some((t) => matchesQuery(t, needle))
          )
        : playlists,
    [playlists, needle]
  );

  const selectTab = useCallback(
    (tab: LibraryTab) => {
      setLocalTab(tab);
      /*
       * Маршрут ставится для всех четырёх закладок, включая «Офлайн».
       *
       * Раньше у него маршрута не было, и выбранная закладка выводилась из
       * `activeView` всякий раз, когда тот указывал на «Избранное» или
       * «Плейлисты», — до `localTab` вывод просто не доходил. То есть с этих
       * двух закладок «Офлайн» **не открывался**: нажатие проходило, состояние
       * менялось, экран оставался прежним. Чинить это сравнением состояний
       * бессмысленно: `localTab` — состояние React, `activeView` — стор
       * снаружи, и приходят они двумя волнами.
       */
      setActiveView(tab);
    },
    [setActiveView]
  );

  /** Arrow keys move through the strip and activate as they go. */
  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key)) return;

    e.preventDefault();
    const current = TABS.findIndex((t) => t.tab === activeTab);
    let next = current;

    if (e.key === 'ArrowRight') next = (current + 1) % TABS.length;
    if (e.key === 'ArrowLeft') next = (current - 1 + TABS.length) % TABS.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = TABS.length - 1;

    selectTab(TABS[next].tab);
    tablistRef.current
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };

  const handleOpenPlaylist = (id: string) => {
    setActivePlaylistId(id);
    setActiveView('playlist');
  };

  const handlePlayPlaylist = async (e: React.MouseEvent, tracks: UnifiedTrack[]) => {
    e.stopPropagation();
    if (tracks.length === 0) return;
    await playTrack(tracks[0], tracks, 0);
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const { id, title } = pendingDelete;
    setPendingDelete(null);

    if (!(await deletePlaylist(id))) {
      showToast(useLibraryStore.getState().error ?? 'Не удалось удалить плейлист.', 'error');
      return;
    }
    showToast(`Плейлист «${title}» удалён`, 'info');
  };

  const handleConfirmClearHistory = async () => {
    setIsClearingHistory(false);
    if (!(await clearHistory())) {
      showToast(useLibraryStore.getState().error ?? 'Не удалось очистить историю.', 'error');
      return;
    }
    showToast('История прослушиваний очищена', 'info');
  };

  const showTrackTools = activeTab !== 'playlists';

  /**
   * Ряд «поиск + сортировка», принимающий хвостовую кнопку.
   *
   * Хвост нужен телефону: там заголовок раздела скрыт, и кнопка, стоявшая с
   * ним в одном ряду, оставалась в пустой полосе высотой в шесть десятков
   * пикселей — на экране в 800 это заметно.
   */
  const buildToolbar = (trailing?: React.ReactNode) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        flexWrap: 'wrap'
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          // На 360 px основание в 260 px не оставляет места сортировке, и она
          // уезжала на вторую строку — ещё один ярус перед списком. С `1 1 0`
          // поле отдаёт ровно столько, сколько нужно соседу.
          flex: isNarrow ? '1 1 120px' : '1 1 260px',
          minWidth: 0,
          maxWidth: '360px',
          padding: '0 var(--space-3)',
          backgroundColor: 'var(--surface-sunken)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)'
        }}
      >
        <Search size={ICON.md} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            activeTab === 'playlists'
              ? 'Поиск по плейлистам…'
              : isNarrow
              ? 'Поиск…'
              : 'Поиск по названию или артисту…'
          }
          aria-label={activeTab === 'playlists' ? 'Поиск по плейлистам' : 'Поиск по трекам'}
          style={{
            flex: 1,
            minWidth: 0,
            padding: 'var(--space-2) 0',
            background: 'transparent',
            border: 'none',
            fontSize: 'var(--text-sm)'
          }}
          data-testid="library-search-input"
        />
      </label>

      {showTrackTools && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            // `select` не сжимается сам: его ширину задаёт самый длинный
            // вариант списка. Без потолка он забирал место у поля поиска, и
            // подсказка в нём обрезалась на втором слоге.
            minWidth: 0,
            maxWidth: isNarrow ? '44%' : undefined
          }}
        >
          {isNarrow ? null : 'Сортировка'}
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            style={{ fontSize: 'var(--text-sm)', minWidth: 0, maxWidth: '100%' }}
            data-testid="library-sort-select"
          >
            {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {isNarrow ? SORT_LABELS_SHORT[mode] : SORT_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
      )}

      {trailing}
    </div>
  );

  const toolbar = buildToolbar();

  return (
    <>
      <div
        className={`animate-view-in ${className}`}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)', width: '100%' }}
        data-testid="library-view"
      >
        <div
          ref={tablistRef}
          role="tablist"
          aria-label="Разделы медиатеки"
          onKeyDown={handleTabKeyDown}
          className="scroll-x-quiet"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            padding: 'var(--space-1)',
            // `fit-content` в узком окне давал ряд шире экрана, и `overflow-x:
            // hidden` у прокручиваемой области отрезал последние вкладки
            // насовсем: «Офлайн» не было ни видно, ни как достать.
            // `max-content` с прокруткой по горизонтали оставляет ряд той же
            // ширины, но добираться до края теперь можно пальцем.
            width: 'max-content',
            maxWidth: '100%',
            overflowX: 'auto',
            backgroundColor: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)'
          }}
        >
          {TABS.map((descriptor) => {
            const isSelected = descriptor.tab === activeTab;
            const count =
              descriptor.tab === 'playlists'
                ? playlists.length
                : descriptor.tab === 'favorites'
                ? favorites.length
                : descriptor.tab === 'offline'
                ? offlineCount
                : recentlyPlayed.length;

            return (
              <button
                key={descriptor.tab}
                type="button"
                role="tab"
                id={`library-tab-${descriptor.tab}`}
                aria-selected={isSelected}
                aria-controls={`library-panel-${descriptor.tab}`}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => selectTab(descriptor.tab)}
                className="chip"
                style={{
                  gap: 'var(--space-2)',
                  padding: 'var(--space-2) var(--space-4)',
                  // Цвет выбранной закладки — в `.chip[aria-selected='true']`
                  // (global.css §13). Инлайновый фон здесь глушил `.chip:hover`
                  // у всех закладок сразу: инлайн старше правила таблицы, и
                  // невыбранные закладки не отвечали на наведение.
                  fontWeight: isSelected ? 'var(--weight-semibold)' : 'var(--weight-medium)'
                }}
                data-testid={descriptor.testId}
              >
                {descriptor.icon}
                <span>{descriptor.label}</span>
                <span data-numeric style={{ color: 'var(--text-muted)' }}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {activeTab === 'library' && (
          <div
            role="tabpanel"
            id="library-panel-library"
            aria-labelledby="library-tab-library"
            tabIndex={0}
            /* Проявление на самой панели, а не на корне раздела. Три закладки из
               четырёх меняют `activeView`, App перемонтирует раздел по ключу, и
               появление разыгрывается само; «Офлайн» вида не меняет и молча
               появлялся без движения. Панель при переключении монтируется заново
               в любом случае, поэтому одинаковый класс на всех четырёх делает
               поведение одинаковым, не завязываясь на то, какая закладка
               заодно является разделом. */
            className="animate-fade-in"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
          >
            <div
              style={{
                // На телефоне здесь не остаётся ничего: заголовок скрыт, а
                // корзина уехала в ряд с поиском. Пустой ряд всё равно занял
                // бы свою высоту и зазор родителя.
                display: isNarrow ? 'none' : 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--space-4)'
              }}
            >
              {!isNarrow && (
                <div>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: 'var(--text-xl)',
                      lineHeight: 'var(--leading-xl)',
                      color: 'var(--text-primary)'
                    }}
                  >
                    Недавно прослушанное
                  </h2>
                  <p
                    style={{
                      margin: 'var(--space-1) 0 0 0',
                      fontSize: 'var(--text-sm)',
                      lineHeight: 'var(--leading-sm)',
                      color: 'var(--text-secondary)'
                    }}
                  >
                    {describeTrackTotals(visibleHistory)} · сначала новые
                  </p>
                </div>
              )}

              {recentlyPlayed.length > 0 && (
                <Button
                  variant="ghost"
                  size={isNarrow ? 'icon' : 'sm'}
                  icon={<Trash2 size={ICON.md} aria-hidden="true" />}
                  onClick={() => setIsClearingHistory(true)}
                  title="Очистить историю"
                  aria-label="Очистить историю"
                  style={isNarrow ? { marginLeft: 'auto' } : undefined}
                  data-testid="clear-history-btn"
                >
                  {isNarrow ? null : 'Очистить историю'}
                </Button>
              )}
            </div>

            {buildToolbar(
              isNarrow && recentlyPlayed.length > 0 ? (
                <Button
                  variant="ghost"
                  size="icon"
                  icon={<Trash2 size={ICON.md} aria-hidden="true" />}
                  onClick={() => setIsClearingHistory(true)}
                  title="Очистить историю"
                  aria-label="Очистить историю"
                  data-testid="clear-history-btn"
                />
              ) : null
            )}

            {isLoading ? (
              <Skeleton count={5} height={54} radius="var(--radius-sm)" />
            ) : recentlyPlayed.length === 0 ? (
              <EmptyState
                icon={<Clock size={ICON.display} />}
                title="Здесь пока пусто"
                description="Всё, что вы слушаете, появляется здесь — сначала новое."
                action={
                  <Button variant="secondary" size="sm" onClick={() => setActiveView('search')}>
                    Найти, что послушать
                  </Button>
                }
                data-testid="history-empty"
              />
            ) : visibleHistory.length === 0 ? (
              <EmptyState
                icon={<Clock size={ICON.display} />}
                title="Ничего не нашлось"
                description={`Среди прослушанного нет ничего по запросу «${query}».`}
                data-testid="history-no-matches"
              />
            ) : (
              <div
                ref={historyVirtual.containerRef}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-1)',
                  paddingTop: historyVirtual.paddingTop,
                  paddingBottom: historyVirtual.paddingBottom
                }}
              >
                {visibleHistory
                  .slice(historyVirtual.startIndex, historyVirtual.endIndex)
                  .map((track, offset) => {
                    const index = historyVirtual.startIndex + offset;
                    return (
                  <div
                    key={track.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                    data-testid={`history-row-${index}`}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <TrackCard
                        track={track}
                        index={index}
                        layout="row"
                        contextQueue={visibleHistory}
                        showIndex
                      />
                    </div>
                    {/*
                      * На телефоне этой кнопки нет: она делает ровно то же, что
                      * нажатие на саму строку, — включает трек. За это удобство
                      * она забирала 50 px из 328, и названию оставалось 156 —
                      * «Ghosts of the Lat…» при том, что имя артиста под ним
                      * шло во всю ширину. На широком окне место есть, и там
                      * подпись «Послушать снова» объясняет, зачем список
                      * недавнего вообще нужен.
                      */}
                    {!isNarrow && (
                      <Button
                        variant="icon"
                        onClick={() => void playTrack(track, visibleHistory, index)}
                        aria-label={`Послушать «${track.title}» снова`}
                        title="Послушать снова"
                        data-testid={`history-play-again-${index}`}
                      >
                        <RotateCcw size={ICON.md} />
                      </Button>
                    )}
                  </div>
                    );
                  })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'favorites' && (
          <div
            role="tabpanel"
            id="library-panel-favorites"
            aria-labelledby="library-tab-favorites"
            tabIndex={0}
            /* Проявление здесь по той же причине, что и у панели «Недавние». */
            className="animate-fade-in"
          >
            <FavoritesView
              tracks={visibleFavorites}
              totalCount={favorites.length}
              query={query}
              isLoading={isLoading}
              toolbar={toolbar}
            />
          </div>
        )}

        {activeTab === 'playlists' && (
          <div
            role="tabpanel"
            id="library-panel-playlists"
            aria-labelledby="library-tab-playlists"
            tabIndex={0}
            /* Проявление здесь по той же причине, что и у панели «Недавние». */
            className="animate-fade-in"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                // Заголовок и две кнопки в один ряд не влезают уже на 360 px:
                // ряд не переносился, и «Новый плейлист» уходил за правый край
                // насовсем — прокрутки по горизонтали у области содержимого нет.
                flexWrap: 'wrap',
                gap: 'var(--space-4)'
              }}
            >
              {/* На телефоне закладка «Плейлисты» стоит прямо над этим
                  заголовком и говорит ровно то же самое. */}
              {!isNarrow && (
                <h2
                  style={{
                    margin: 0,
                    fontSize: 'var(--text-xl)',
                    lineHeight: 'var(--leading-xl)',
                    color: 'var(--text-primary)'
                  }}
                >
                  Ваши плейлисты
                </h2>
              )}
              {/*
                * Пока плейлистов нет, этих кнопок здесь нет тоже.
                *
                * Пустой экран уже предлагает ровно те же два действия своими
                * кнопками — и предлагает их посередине, где на них смотрят.
                * Две пары одинаковых кнопок на одном экране — это не «удобно с
                * двух мест», а вопрос «а эти делают что-то другое?».
                * DESIGN_SYSTEM §15 запрещает два органа управления с одним
                * действием, и это ровно тот случай.
                */}
              {playlists.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Import size={ICON.md} aria-hidden="true" />}
                    onClick={onImportPlaylistClick || (() => setIsImportModalOpen(true))}
                    data-testid="library-import-playlist-btn"
                  >
                    {/* На 360 px две подписанные кнопки в ряд не помещаются и
                        встают столбиком — два яруса до первого плейлиста. */}
                    {isNarrow ? 'Импорт' : 'Импортировать'}
                  </Button>
                  {onCreatePlaylistClick && (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Plus size={ICON.md} aria-hidden="true" />}
                      onClick={onCreatePlaylistClick}
                      data-testid="library-create-playlist-btn"
                    >
                      {isNarrow ? 'Новый' : 'Новый плейлист'}
                    </Button>
                  )}
                </div>
              )}
            </div>

            {/* Искать среди ничего нечего: поле поиска над пустым экраном
                только отодвигает вниз то единственное, что на нём есть. */}
            {playlists.length > 0 && toolbar}

            {isLoading ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                  gap: 'var(--space-4)'
                }}
              >
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} height={248} radius="var(--radius-md)" />
                ))}
              </div>
            ) : playlists.length === 0 ? (
              <EmptyState
                icon={<Disc size={ICON.display} />}
                title="Плейлистов пока нет"
                description="Соберите вместе треки, которые хочется слушать подряд."
                action={
                  <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Import size={ICON.md} aria-hidden="true" />}
                      onClick={onImportPlaylistClick || (() => setIsImportModalOpen(true))}
                      data-testid="library-empty-import-playlist-btn"
                    >
                      Импортировать плейлист
                    </Button>
                    {onCreatePlaylistClick && (
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<Plus size={ICON.md} aria-hidden="true" />}
                        onClick={onCreatePlaylistClick}
                      >
                        Создать плейлист
                      </Button>
                    )}
                  </div>
                }
                data-testid="library-empty-playlists"
              />
            ) : visiblePlaylists.length === 0 ? (
              <EmptyState
                icon={<Disc size={ICON.display} />}
                title="Ничего не нашлось"
                description={`Ни один плейлист не подходит под «${query}».`}
                data-testid="playlists-no-matches"
              />
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                  gap: 'var(--space-4)'
                }}
              >
                {visiblePlaylists.map((playlist, index) => (
                  <div
                    key={playlist.id}
                    // Оседание и блик — только здесь: во всей медиатеке это
                    // единственная сетка карточек. Строки треков ниже их не
                    // получают, там задержка по номеру превратилась бы в лестницу.
                    className="card-interactive animate-settle hover-sheen"
                    onClick={() => handleOpenPlaylist(playlist.id)}
                    style={{
                      '--stagger': index,
                      padding: 'var(--space-3)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-3)',
                      position: 'relative'
                    } as React.CSSProperties}
                    data-testid={`playlist-card-${playlist.id}`}
                  >
                    <div style={{ position: 'relative' }}>
                      <PlaylistCover tracks={playlist.tracks} size="100%" />
                      {playlist.tracks.length > 0 && (
                        <Button
                          variant="primary"
                          size="icon"
                          onClick={(e) => void handlePlayPlaylist(e, playlist.tracks)}
                          aria-label={`Включить плейлист «${playlist.title}»`}
                          title="Включить плейлист"
                          style={{
                            position: 'absolute',
                            right: 'var(--space-2)',
                            bottom: 'var(--space-2)',
                            borderRadius: 'var(--radius-full)'
                          }}
                          data-testid={`playlist-play-${playlist.id}`}
                        >
                          <Play size={ICON.md} />
                        </Button>
                      )}
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        justifyContent: 'space-between',
                        gap: 'var(--space-2)'
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenPlaylist(playlist.id);
                          }}
                          className="text-truncate focus-ring"
                          style={{
                            display: 'block',
                            maxWidth: '100%',
                            fontSize: 'var(--text-base)',
                            lineHeight: 'var(--leading-base)',
                            fontWeight: 'var(--weight-semibold)',
                            color: 'var(--text-primary)',
                            textAlign: 'left'
                          }}
                          data-testid={`playlist-open-${playlist.id}`}
                        >
                          {playlist.title}
                        </button>
                        <p
                          style={{
                            margin: 'var(--space-1) 0 0 0',
                            fontSize: 'var(--text-xs)',
                            lineHeight: 'var(--leading-xs)',
                            color: 'var(--text-muted)'
                          }}
                        >
                          {describeTrackTotals(playlist.tracks)}
                        </p>
                      </div>

                      <Button
                        variant="icon"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete({ id: playlist.id, title: playlist.title });
                        }}
                        aria-label={`Удалить плейлист «${playlist.title}»`}
                        title="Удалить плейлист"
                        style={{ width: '28px', height: '28px' }}
                        data-testid={`playlist-delete-${playlist.id}`}
                      >
                        <Trash2 size={ICON.sm} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'offline' && (
          <div
            role="tabpanel"
            id="library-panel-offline"
            aria-labelledby="library-tab-offline"
            tabIndex={0}
            /* Проявление здесь по той же причине, что и у панели «Недавние», и
               ради этой закладки правило и появилось: «Офлайн» — единственная,
               которая не меняет `activeView`. */
            className="animate-fade-in"
          >
            <OfflineSection />
          </div>
        )}
      </div>

      {/* Диалоги — рядом с корнем раздела, а не внутри него: это не содержимое
          медиатеки, а слой поверх окна, и место в разметке у него соответственное.
          Раньше здесь стояла другая причина — `animate-view-in` оставлял на корне
          преобразование, а элемент с преобразованием становится системой отсчёта
          для `position: fixed`, и затемнение мерилось по разделу вместо окна. Это
          исправлено в самих кадрах (`transform: none` вместо единичного значения,
          см. freshness.test.ts), так что запрета больше нет — есть только то, что
          так честнее по смыслу. */}
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title={pendingDelete ? `Удалить «${pendingDelete.title}»?` : 'Удалить плейлист?'}
        description="Плейлист исчезнет с этого устройства. Сами треки останутся доступны."
        confirmLabel="Удалить плейлист"
        danger
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        isOpen={isClearingHistory}
        title="Очистить историю прослушиваний?"
        description="Раздел «Недавнее» опустеет. Избранное и плейлисты не тронуты."
        confirmLabel="Очистить историю"
        danger
        onConfirm={() => void handleConfirmClearHistory()}
        onCancel={() => setIsClearingHistory(false)}
      />

      <ImportPlaylistModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
      />
    </>
  );
};
