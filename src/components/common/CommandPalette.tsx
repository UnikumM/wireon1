import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Heart,
  Library,
  Link2,
  ListMusic,
  Maximize2,
  Moon,
  Music,
  Pause,
  Play,
  Radio,
  Repeat,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
  UserRound,
  Volume2
} from 'lucide-react';
import { useDismissable } from '../../hooks/useDismissable';
import { useTrackTagsIndex } from '../../hooks/useTrackNote';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useSmartPlaylistStore } from '../../store/useSmartPlaylistStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { pluralize } from '../../utils/plural';
import { formatDuration } from '../../utils/time';
import { ICON } from '../../styles/icons';
import type { UnifiedTrack } from '../../types/music';
import {
  artistKey,
  collectLibraryTracks,
  looksLikeUrl,
  searchArtists,
  searchPlaylists,
  searchTracks,
  TRACK_LIMIT,
  type TagsById
} from './commandPalette/librarySearch';

interface Command {
  id: string;
  label: string;
  /** Right-hand hint: current value, shortcut or destination. */
  hint?: string;
  group: string;
  icon: React.ReactNode;
  /**
   * Extra words the query may match against. Держим здесь и английские слова:
   * с русской раскладкой человек ищет «переме», без неё — «shuffle», и оба
   * варианта должны находить одну и ту же команду.
   */
  keywords?: string;
  run: () => void;
}

interface ScoredCommand {
  command: Command;
  score: number;
}

/**
 * Subsequence match with bonuses for consecutive hits and word starts, so «прмш»
 * finds «Перемешать очередь» and ranks it above an incidental match.
 */
function fuzzyScore(haystack: string, needle: string): number | null {
  if (needle.length === 0) return 0;

  const text = haystack.toLowerCase();
  const query = needle.toLowerCase();

  let score = 0;
  let textIndex = 0;
  let previousMatch = -2;

  for (let i = 0; i < query.length; i++) {
    const char = query[i];
    const found = text.indexOf(char, textIndex);
    if (found === -1) return null;

    score += 1;
    if (found === previousMatch + 1) score += 3;
    if (found === 0 || text[found - 1] === ' ' || text[found - 1] === ':') score += 2;

    previousMatch = found;
    textIndex = found + 1;
  }

  // Prefer the tighter match when two entries both contain the query.
  return score - Math.floor(text.length / 24);
}

function useCommands(): Command[] {
  const playlists = useLibraryStore((s) => s.playlists);
  const smartPlaylists = useSmartPlaylistStore((s) => s.playlists);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isShuffled = usePlayerStore((s) => s.isShuffled);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const visualizerEnabled = usePlayerStore((s) => s.visualizerEnabled);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
  const sleepAtTrackEnd = usePlayerStore((s) => s.sleepAtTrackEnd);
  const isQueueOpen = useUIStore((s) => s.isQueueOpen);
  const isFullscreenPlayerOpen = useUIStore((s) => s.isFullscreenPlayerOpen);

  return useMemo(() => {
    const ui = useUIStore.getState();
    const goTo = (view: 'search' | 'wave' | 'foryou' | 'library' | 'favorites' | 'playlists' | 'settings') => () => {
      ui.setActivePlaylistId(null);
      ui.setActiveView(view);
    };

    const navigation: Command[] = [
      { id: 'go-search', label: 'Открыть поиск', group: 'Навигация', icon: <Search size={ICON.md} />, keywords: 'search find explore поиск найти', run: goTo('search') },
      { id: 'go-wave', label: 'Открыть Поток', group: 'Навигация', icon: <Radio size={ICON.md} />, keywords: 'wave radio stream smart flow vibe поток волна радио', run: goTo('wave') },
      // Звёздочки здесь — тот же значок, что у «Для вас» в боковой панели: один
      // раздел не должен выглядеть по-разному в двух местах. Единственное место
      // в приложении, где они уцелели, — см. комментарий в Sidebar.
      { id: 'recap-month', label: 'Итоги месяца', group: 'Навигация', icon: <Sparkles size={ICON.md} />, keywords: 'wrapped recap итоги месяц статистика истории', run: () => ui.openRecap('month') },
      { id: 'recap-year', label: 'Итоги года', group: 'Навигация', icon: <Sparkles size={ICON.md} />, keywords: 'wrapped recap итоги год статистика истории', run: () => ui.openRecap('year') },
      { id: 'go-foryou', label: 'Открыть «Для вас»', group: 'Навигация', icon: <Sparkles size={ICON.md} />, keywords: 'for you mixes stats daily миксы дня итоги статистика для вас', run: goTo('foryou') },
      { id: 'go-library', label: 'Открыть медиатеку', group: 'Навигация', icon: <Library size={ICON.md} />, keywords: 'library tracks history медиатека треки история', run: goTo('library') },
      { id: 'go-favorites', label: 'Открыть избранное', group: 'Навигация', icon: <Heart size={ICON.md} />, keywords: 'favorites liked hearts избранное лайки нравится', run: goTo('favorites') },
      { id: 'go-playlists', label: 'Открыть плейлисты', group: 'Навигация', icon: <ListMusic size={ICON.md} />, keywords: 'подборки собрания', run: goTo('playlists') },
      { id: 'go-settings', label: 'Открыть настройки', group: 'Навигация', icon: <Settings size={ICON.md} />, keywords: 'settings preferences options eq настройки параметры эквалайзер', run: goTo('settings') }
    ];

    const playback: Command[] = [
      {
        id: 'toggle-play',
        label: isPlaying ? 'Пауза' : 'Играть',
        group: 'Воспроизведение',
        icon: isPlaying ? <Pause size={ICON.md} /> : <Play size={ICON.md} />,
        keywords: 'play pause resume space играть пауза продолжить пробел',
        run: () => void usePlayerStore.getState().togglePlayPause()
      },
      {
        id: 'next-track',
        label: 'Следующий трек',
        group: 'Воспроизведение',
        icon: <SkipForward size={ICON.md} />,
        keywords: 'next skip forward вперёд дальше пропустить',
        run: () => void usePlayerStore.getState().nextTrack(true)
      },
      {
        id: 'prev-track',
        label: 'Предыдущий трек',
        group: 'Воспроизведение',
        icon: <SkipBack size={ICON.md} />,
        keywords: 'previous back rewind назад прошлый',
        run: () => void usePlayerStore.getState().prevTrack()
      },
      {
        id: 'toggle-shuffle',
        label: 'Перемешать очередь',
        hint: isShuffled ? 'Вкл' : 'Выкл',
        group: 'Воспроизведение',
        icon: <Shuffle size={ICON.md} />,
        keywords: 'toggle shuffle random вперемешку случайно',
        run: () => usePlayerStore.getState().toggleShuffle()
      },
      {
        id: 'cycle-repeat',
        label: 'Сменить режим повтора',
        hint: repeatMode === 'off' ? 'Выкл' : repeatMode === 'one' ? 'Один трек' : 'Вся очередь',
        group: 'Воспроизведение',
        icon: <Repeat size={ICON.md} />,
        keywords: 'repeat loop повтор зациклить',
        run: () => usePlayerStore.getState().cycleRepeatMode()
      },
      {
        id: 'toggle-mute',
        label: isMuted ? 'Включить звук' : 'Выключить звук',
        group: 'Воспроизведение',
        icon: <Volume2 size={ICON.md} />,
        keywords: 'mute unmute volume silence громкость тишина беззвучно',
        run: () => usePlayerStore.getState().toggleMute()
      }
    ];

    const view: Command[] = [
      {
        id: 'toggle-queue',
        label: isQueueOpen ? 'Закрыть очередь' : 'Открыть очередь',
        group: 'Вид',
        icon: <ListMusic size={ICON.md} />,
        keywords: 'queue up next drawer очередь дальше',
        run: () => useUIStore.getState().toggleQueue()
      },
      {
        id: 'toggle-fullscreen',
        label: isFullscreenPlayerOpen ? 'Выйти из полноэкранного режима' : 'Полноэкранный режим',
        group: 'Вид',
        icon: <Maximize2 size={ICON.md} />,
        keywords: 'fullscreen now playing immersive полный экран сейчас играет',
        run: () => useUIStore.getState().toggleFullscreenPlayer()
      },
      {
        id: 'toggle-visualizer',
        label: visualizerEnabled ? 'Выключить визуализацию' : 'Включить визуализацию',
        group: 'Вид',
        // Полосы спектра, а не звёздочки: команда включает именно их.
        icon: <AudioLines size={ICON.md} />,
        keywords: 'visualizer spectrum bars визуализация спектр полосы',
        run: () => usePlayerStore.getState().setVisualizerEnabled(!visualizerEnabled)
      }
    ];

    const sleep: Command[] = [15, 30, 60].map((minutes) => ({
      id: `sleep-${minutes}`,
      label: `Таймер сна: ${minutes} минут`,
      group: 'Таймер сна',
      icon: <Moon size={ICON.md} />,
      keywords: 'sleep bedtime stop after уснуть выключить через',
      run: () => usePlayerStore.getState().setSleepTimer(minutes)
    }));

    sleep.push({
      id: 'sleep-track-end',
      label: 'Таймер сна: до конца трека',
      group: 'Таймер сна',
      icon: <Moon size={ICON.md} />,
      keywords: 'sleep end of track конец трека доиграет',
      run: () => usePlayerStore.getState().setSleepAtTrackEnd(true)
    });

    if (sleepTimerEndsAt !== null || sleepAtTrackEnd) {
      sleep.push({
        id: 'sleep-off',
        label: 'Отключить таймер сна',
        group: 'Таймер сна',
        icon: <Moon size={ICON.md} />,
        keywords: 'sleep cancel off отменить сброс',
        run: () => usePlayerStore.getState().setSleepTimer(null)
      });
    }

    const playlistCommands: Command[] = playlists.map((playlist) => ({
      id: `playlist-${playlist.id}`,
      label: `Открыть плейлист: ${playlist.title}`,
      hint: pluralize(playlist.tracks.length, 'трек', 'трека', 'треков'),
      group: 'Плейлисты',
      icon: <Music size={ICON.md} />,
      run: () => {
        const store = useUIStore.getState();
        store.setActivePlaylistId(playlist.id);
        store.setActiveView('playlist');
      }
    }));

    const smartCommands: Command[] = smartPlaylists.map((smart) => ({
      id: `smart-${smart.id}`,
      label: `Открыть умный плейлист: ${smart.title}`,
      hint: 'по правилам',
      group: 'Плейлисты',
      icon: <Music size={ICON.md} />,
      keywords: 'smart умный правила',
      run: () => useUIStore.getState().openSmartPlaylist(smart.id)
    }));

    const queueCommands: Command[] = [
      {
        id: 'queue-save-playlist',
        label: 'Сохранить очередь плейлистом',
        group: 'Плейлисты',
        icon: <Music size={ICON.md} />,
        keywords: 'queue save playlist очередь сохранить',
        run: () => {
          const player = usePlayerStore.getState();
          const order =
            player.isShuffled && player.shuffleOrder.length > 0
              ? player.shuffleOrder
              : player.sourceQueue.map((_, i) => i);
          const pos = order.indexOf(player.currentIndex);
          const upcoming = (pos === -1 ? order : order.slice(pos + 1)).map((i) => player.sourceQueue[i]).filter(Boolean);
          const list = [...(player.currentTrack ? [player.currentTrack] : []), ...player.userQueue, ...upcoming];
          if (list.length === 0) {
            useUIStore.getState().showToast('Очередь пуста', 'info');
            return;
          }
          const date = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
          void useLibraryStore
            .getState()
            .createPlaylistWithTracks(`Очередь · ${date}`, list)
            .then((created) => {
              if (created) useUIStore.getState().showToast(`Сохранено в «${created.title}»`, 'success');
            });
        }
      }
    ];

    return [...navigation, ...playback, ...view, ...sleep, ...playlistCommands, ...smartCommands, ...queueCommands];
  }, [
    playlists,
    smartPlaylists,
    isPlaying,
    isShuffled,
    repeatMode,
    isMuted,
    visualizerEnabled,
    sleepTimerEndsAt,
    sleepAtTrackEnd,
    isQueueOpen,
    isFullscreenPlayerOpen
  ]);
}

const LISTBOX_ID = 'command-palette-listbox';

/**
 * Строка результата любой природы: команда, трек, плейлист, артист или
 * действие «искать в сети». `section` — заголовок группы над строкой, `id`
 * даёт DOM-идентификатор `command-<id>` и testid `command-option-<id>`.
 */
interface PaletteItem {
  id: string;
  section: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  /** Для трека рисуется обложка и артист вместо значка и подсказки. */
  track?: UnifiedTrack;
  run: () => void;
}

function commandItem(command: Command, section: string): PaletteItem {
  return {
    id: command.id,
    section,
    label: command.label,
    hint: command.hint,
    icon: command.icon,
    run: command.run
  };
}

/** Один переход в поиск: и для ссылки, и для запроса, которого нет в медиатеке. */
function goSearch(query: string) {
  const ui = useUIStore.getState();
  ui.setActivePlaylistId(null);
  ui.setActiveView('search');
  ui.setSearchQuery(query);
}

/**
 * Собирает список палитры по запросу: без запроса — все команды по своим
 * группам; с запросом — команды, треки, плейлисты и артисты из медиатеки.
 * Ссылка открывается в поиске; если ничего не нашлось — предлагается
 * поискать в сети.
 */
function buildItems(
  commands: Command[],
  query: string,
  library: {
    tracks: UnifiedTrack[];
    playlists: ReturnType<typeof useLibraryStore.getState>['playlists'];
    /** Свои теги треков: `#бег` и слово, совпавшее с тегом, находят трек. */
    tagsById?: TagsById;
  }
): PaletteItem[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return commands.map((command) => commandItem(command, command.group));

  if (looksLikeUrl(trimmed)) {
    return [
      {
        id: 'open-link',
        section: 'Ссылка',
        label: 'Открыть ссылку в поиске',
        hint: trimmed,
        icon: <Link2 size={ICON.md} />,
        run: () => goSearch(trimmed)
      }
    ];
  }

  const matchedCommands = commands
    // Плейлисты с запросом ищутся своей группой ниже, иначе один и тот же
    // плейлист всплывал бы дважды.
    .filter((command) => !command.id.startsWith('playlist-'))
    .reduce<ScoredCommand[]>((acc, command) => {
      const haystack = `${command.label} ${command.group} ${command.keywords ?? ''}`;
      const score = fuzzyScore(haystack, trimmed);
      if (score !== null) acc.push({ command, score });
      return acc;
    }, [])
    .sort((a, b) => b.score - a.score)
    .map((entry) => commandItem(entry.command, 'Команды'));

  const trackItems: PaletteItem[] = searchTracks(library.tracks, trimmed, TRACK_LIMIT, library.tagsById).map((track) => ({
    id: `track-${track.id}`,
    section: 'Треки',
    label: track.title,
    hint: track.artist,
    icon: <Music size={ICON.md} />,
    track,
    run: () => void usePlayerStore.getState().playTrack(track)
  }));

  const playlistItems: PaletteItem[] = searchPlaylists(library.playlists, trimmed).map((playlist) => ({
    id: `playlist-${playlist.id}`,
    section: 'Плейлисты',
    label: playlist.title,
    hint: pluralize(playlist.tracks.length, 'трек', 'трека', 'треков'),
    icon: <ListMusic size={ICON.md} />,
    run: () => {
      const ui = useUIStore.getState();
      ui.setActivePlaylistId(playlist.id);
      ui.setActiveView('playlist');
    }
  }));

  const artistItems: PaletteItem[] = searchArtists(library.tracks, trimmed).map((name) => ({
    id: `artist-${artistKey(name)}`,
    section: 'Артисты',
    label: name,
    icon: <UserRound size={ICON.md} />,
    run: () => useUIStore.getState().openArtist(name)
  }));

  const items = [...matchedCommands, ...trackItems, ...playlistItems, ...artistItems];
  if (items.length > 0) return items;

  return [
    {
      id: 'search-web',
      section: 'Поиск',
      label: `Искать „${trimmed}“ в YouTube и SoundCloud`,
      icon: <Search size={ICON.md} />,
      run: () => goSearch(trimmed)
    }
  ];
}

/**
 * `Ctrl/Cmd+K` — одна строка для всего: команды, разделы, а с запросом ещё
 * треки, плейлисты и артисты из медиатеки. Кроссплатформенно — ничего
 * специфичного для Electron здесь нет.
 */
export const CommandPalette: React.FC = () => {
  const isOpen = useUIStore((s) => s.isCommandPaletteOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const commands = useCommands();
  const favorites = useLibraryStore((s) => s.favorites);
  const history = useLibraryStore((s) => s.history);
  const playlists = useLibraryStore((s) => s.playlists);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const { containerRef, backdropProps } = useDismissable<HTMLDivElement>({
    isOpen,
    onDismiss: () => setCommandPaletteOpen(false)
  });

  const libraryTracks = useMemo(
    () => collectLibraryTracks(favorites, history, playlists),
    [favorites, history, playlists]
  );

  const tagsById = useTrackTagsIndex();

  const results = useMemo(
    () => buildItems(commands, query, { tracks: libraryTracks, playlists, tagsById }),
    [commands, query, libraryTracks, playlists, tagsById]
  );

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [isOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, isOpen, results.length]);

  if (!isOpen) return null;

  const activate = (item: PaletteItem | undefined) => {
    if (!item) return;
    setCommandPaletteOpen(false);
    item.run();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % results.length);
        return;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + results.length) % results.length);
        return;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        return;
      case 'End':
        event.preventDefault();
        setActiveIndex(results.length - 1);
        return;
      case 'Enter':
        event.preventDefault();
        activate(results[activeIndex]);
        return;
      default:
        return;
    }
  };

  const trimmedQuery = query.trim();
  const nothingFound = trimmedQuery.length > 0 && results.length === 1 && results[0].id === 'search-web';
  let lastSection: string | null = null;

  return (
    <div
      className="palette-backdrop animate-fade-in"
      {...backdropProps}
      data-testid="command-palette-backdrop"
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Палитра команд"
        // Палитра висит у верхнего края экрана, и точка роста по умолчанию —
        // `top center` — здесь и нужна: она выпадает сверху, как продолжение
        // нажатия Ctrl+K, а не выныривает снизу мимо своего края.
        className="palette-dialog animate-drop-in"
        data-testid="command-palette"
      >
        <div className="row gap-3 py-3 px-4 border-b-subtle">
          <Search size={ICON.md} aria-hidden="true" className="text-muted shrink-0" />
          <input
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={LISTBOX_ID}
            aria-autocomplete="list"
            aria-activedescendant={results[activeIndex] ? `command-${results[activeIndex].id}` : undefined}
            aria-label="Поиск по командам и медиатеке"
            placeholder="Команды, треки, плейлисты, артисты"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            className="palette-input grow text-base text-primary bg-transparent border-none py-1 px-0"
            data-testid="command-palette-input"
          />
          <kbd className="kbd">Esc</kbd>
        </div>

        <div
          ref={listRef}
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Результаты"
          className="palette-list scrollbar-thin p-2 flex-1 min-h-0"
        >
          {nothingFound && (
            <p className="m-0 text-center text-sm text-muted py-3 px-3" data-testid="command-palette-empty">
              Ничего не нашлось по запросу «{trimmedQuery}».
            </p>
          )}
          {results.map((item, index) => {
            const isActive = index === activeIndex;
            const showSection = item.section !== lastSection;
            lastSection = item.section;

            return (
              <React.Fragment key={item.id}>
                {showSection && (
                  <div role="presentation" className="palette-group section-label text-muted">
                    {item.section}
                  </div>
                )}
                <div
                  id={`command-${item.id}`}
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => activate(item)}
                  className="palette-option"
                  data-testid={`command-option-${item.id}`}
                >
                  {item.track ? (
                    <>
                      {item.track.artworkUrl ? (
                        <img
                          src={item.track.artworkUrl}
                          alt=""
                          loading="lazy"
                          className="palette-cover fill-cover radius-xs shrink-0"
                        />
                      ) : (
                        <span className="palette-cover palette-option-icon row justify-center bg-surface-2 radius-xs shrink-0">
                          <Music size={ICON.sm} />
                        </span>
                      )}
                      <span className="grow text-truncate text-sm">
                        {item.label}
                        {item.hint && <span className="text-muted"> · {item.hint}</span>}
                      </span>
                      <span data-numeric className="text-xs text-muted shrink-0">
                        {formatDuration(item.track.duration)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="palette-option-icon inline-row shrink-0">{item.icon}</span>
                      <span className="text-truncate flex-1 text-sm">{item.label}</span>
                      {item.hint && <span className="text-xs text-muted text-truncate shrink-0 palette-hint">{item.hint}</span>}
                    </>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
};
