import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AudioLines,
  Heart,
  Library,
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
  Volume2
} from 'lucide-react';
import { useDismissable } from '../../hooks/useDismissable';
import { useLibraryStore } from '../../store/useLibraryStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { pluralize } from '../../utils/plural';
import { ICON } from '../../styles/icons';

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
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isShuffled = usePlayerStore((s) => s.isShuffled);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const visualizerEnabled = usePlayerStore((s) => s.visualizerEnabled);
  const sleepTimerEndsAt = usePlayerStore((s) => s.sleepTimerEndsAt);
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

    if (sleepTimerEndsAt !== null) {
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

    return [...navigation, ...playback, ...view, ...sleep, ...playlistCommands];
  }, [
    playlists,
    isPlaying,
    isShuffled,
    repeatMode,
    isMuted,
    visualizerEnabled,
    sleepTimerEndsAt,
    isQueueOpen,
    isFullscreenPlayerOpen
  ]);
}

const LISTBOX_ID = 'command-palette-listbox';

/**
 * `Ctrl/Cmd+K` launcher over navigation, playback toggles and the user's
 * playlists. Cross-platform — nothing in here is Electron-specific.
 */
export const CommandPalette: React.FC = () => {
  const isOpen = useUIStore((s) => s.isCommandPaletteOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const commands = useCommands();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const { containerRef, backdropProps } = useDismissable<HTMLDivElement>({
    isOpen,
    onDismiss: () => setCommandPaletteOpen(false)
  });

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return commands;

    return commands
      .reduce<ScoredCommand[]>((acc, command) => {
        const haystack = `${command.label} ${command.group} ${command.keywords ?? ''}`;
        const score = fuzzyScore(haystack, trimmed);
        if (score !== null) acc.push({ command, score });
        return acc;
      }, [])
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.command);
  }, [commands, query]);

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

  const activate = (command: Command | undefined) => {
    if (!command) return;
    setCommandPaletteOpen(false);
    command.run();
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

  let lastGroup: string | null = null;

  return (
    <div
      className="animate-fade-in"
      {...backdropProps}
      style={
        {
          position: 'fixed',
          inset: 0,
          backgroundColor: 'var(--scrim)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          padding: 'var(--space-8) var(--space-4)',
          zIndex: 'var(--z-modal)'
        } as React.CSSProperties
      }
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
        className="animate-drop-in"
        style={
          {
            width: '100%',
            maxWidth: '560px',
            backgroundColor: 'var(--surface-4)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-xl)',
            boxShadow: 'var(--shadow-lg)',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '60vh',
            '--ring-offset-color': 'var(--surface-4)'
          } as React.CSSProperties
        }
        data-testid="command-palette"
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: 'var(--space-3) var(--space-4)',
            borderBottom: '1px solid var(--border-subtle)'
          }}
        >
          <Search size={ICON.md} aria-hidden="true" style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={LISTBOX_ID}
            aria-autocomplete="list"
            aria-activedescendant={results[activeIndex] ? `command-${results[activeIndex].id}` : undefined}
            aria-label="Поиск по командам"
            placeholder="Команды, разделы и плейлисты…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              boxShadow: 'none',
              padding: 'var(--space-1) 0',
              fontSize: 'var(--text-base)',
              color: 'var(--text-primary)'
            }}
            data-testid="command-palette-input"
          />
          <kbd className="kbd">Esc</kbd>
        </div>

        <div
          ref={listRef}
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Команды"
          className="scrollbar-thin"
          style={{ overflowY: 'auto', padding: 'var(--space-2)', flex: 1, minHeight: 0 }}
        >
          {results.length === 0 ? (
            <p
              style={{
                margin: 0,
                padding: 'var(--space-5) var(--space-3)',
                textAlign: 'center',
                fontSize: 'var(--text-sm)',
                color: 'var(--text-muted)'
              }}
              data-testid="command-palette-empty"
            >
              Нет команд по запросу «{query}».
            </p>
          ) : (
            results.map((command, index) => {
              const isActive = index === activeIndex;
              const showGroup = command.group !== lastGroup && query.trim().length === 0;
              lastGroup = command.group;

              return (
                <React.Fragment key={command.id}>
                  {showGroup && (
                    <div
                      role="presentation"
                      className="section-label"
                      style={{
                        padding: 'var(--space-3) var(--space-3) var(--space-1)',
                        color: 'var(--text-muted)'
                      }}
                    >
                      {command.group}
                    </div>
                  )}
                  <div
                    id={`command-${command.id}`}
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => activate(command)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                      padding: 'var(--space-2) var(--space-3)',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      backgroundColor: isActive ? 'var(--accent-soft)' : 'transparent',
                      border: `1px solid ${isActive ? 'var(--border-accent)' : 'transparent'}`,
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)'
                    }}
                    data-testid={`command-option-${command.id}`}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        flexShrink: 0,
                        color: isActive ? 'var(--accent)' : 'var(--text-muted)'
                      }}
                    >
                      {command.icon}
                    </span>
                    <span className="text-truncate" style={{ flex: 1, fontSize: 'var(--text-sm)' }}>
                      {command.label}
                    </span>
                    {command.hint && (
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>
                        {command.hint}
                      </span>
                    )}
                  </div>
                </React.Fragment>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
