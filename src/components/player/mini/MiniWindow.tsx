import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Heart,
  Maximize2,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X
} from 'lucide-react';
import type { MiniPlayerCommand, MiniPlayerState } from '../../../types/electron';
import { formatDuration } from '../../../utils/time';
import { ICON } from '../../../styles/icons';
import { usePlayerLayoutStore } from '../../../store/usePlayerLayoutStore';
import { miniSkinVars } from '../../../styles/miniSkins';
import { Button } from '../../common/Button';

const EMPTY_STATE: MiniPlayerState = {
  title: '',
  artist: '',
  artwork: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  isFavorite: false,
  shuffle: false,
  repeat: 'off',
  accent: null
};

function send(command: MiniPlayerCommand): void {
  try {
    window.electronAPI?.sendMiniCommand?.(command);
  } catch {
    /* the window is closing; nothing to recover */
  }
}

/**
 * Рамка кнопки окна.
 *
 * Только размер: цвет покоя, фон и ответ на наведение живут в правилах
 * `.wireon-btn[data-variant='icon']`. Пока они стояли здесь, инлайн перебивал
 * `:hover` — все девять кнопок окна на наведение не отвечали. Ступень
 * `--control-sm` (28px) взята в пару к `ICON.sm` (14px): зазор получается целым,
 * и глиф не съезжает с центра на полпикселя.
 */
const ICON_BUTTON: React.CSSProperties = {
  width: 'var(--control-sm)',
  height: 'var(--control-sm)'
};

/**
 * The always-on-top mini player, rendered in its own `BrowserWindow`.
 *
 * It owns no playback: audio lives in the main window, so this is a remote
 * control. State arrives as snapshots over `onMiniState` and every interaction
 * leaves as a `MiniPlayerCommand`. That split is what keeps the two windows from
 * ever disagreeing about what is playing — there is only one player.
 */
export const MiniWindow: React.FC = () => {
  const [state, setState] = useState<MiniPlayerState>(EMPTY_STATE);
  // While a drag is in progress the incoming snapshots would fight the thumb, so
  // the local value wins until the pointer is released.
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [isHovering, setIsHovering] = useState(false);
  const requestedRef = useRef(false);

  /*
   * Облик приходит из двух мест, и у каждого своя работа.
   *
   * Стор — то, что известно до первого снимка: мини-окно рисует свой документ и
   * читает настройки само (`src/main.tsx`), поэтому нужный облик стоит уже в
   * первом кадре, без вспышки вида по умолчанию.
   *
   * Снимок — то, что меняется при открытом окне: настройка живёт в основном окне,
   * это другой процесс отрисовки со своей копией сторов, и без провода выбор
   * доехал бы сюда только к следующему запуску.
   */
  const localSkin = usePlayerLayoutStore((s) => s.miniSkinId);
  const skinId = state.skin ?? localSkin;

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onMiniState?.((next) => setState(next));
    if (!requestedRef.current) {
      requestedRef.current = true;
      // The main window may have pushed its last snapshot before this window
      // finished loading, so ask once on mount instead of showing an empty shell.
      send({ type: 'request-state' });
    }
    return () => unsubscribe?.();
  }, []);

  const handleSeek = useCallback((value: number) => {
    setScrubTime(null);
    send({ type: 'seek', value });
  }, []);

  const hasTrack = state.title !== '';
  const shownTime = scrubTime ?? state.currentTime;
  const progress = state.duration > 0 ? Math.min(100, (shownTime / state.duration) * 100) : 0;
  const trackAccent = state.accent;
  const accent = trackAccent ?? 'var(--accent)';

  /*
   * Цвет включённого переключателя.
   *
   * Само включённое состояние уезжает в CSS через `isActive`, и цвет покоя здесь
   * не пишется вовсе: инлайн старше правила таблицы стилей, поэтому цвет покоя в
   * атрибуте `style` отбирал у кнопки `:hover` целиком. Инлайном остаётся только
   * то, чего таблица стилей знать не может, — цвет, вытянутый из обложки трека и
   * пришедший снимком.
   */
  const activeTint = (on: boolean): React.CSSProperties | undefined =>
    on && trackAccent ? { color: trackAccent } : undefined;

  return (
    <div
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        // Восемь переменных облика — и все восемь читаются здесь же. Инлайн в этом
        // проекте сильнее таблицы стилей, поэтому фон, рамку, радиус и обложку из
        // `mini.css` было бы не подменить: там остаётся характер (вращение,
        // приглушение подписей), а геометрия — только через переменные.
        ...miniSkinVars(skinId),
        backgroundColor: 'var(--mini-tint)',
        backgroundImage: 'var(--mini-overlay)',
        border: 'var(--mini-border)',
        borderRadius: 'var(--mini-radius)',
        boxShadow: 'var(--mini-shadow)',
        backdropFilter: 'var(--mini-blur)',
        userSelect: 'none',
        WebkitAppRegion: 'drag'
      }}
      data-mini-skin={skinId}
      data-playing={state.isPlaying ? 'true' : 'false'}
      data-testid="mini-window"
    >
      {/* Window actions: only on hover, so the player stays clean at a glance. */}
      <div
        style={{
          position: 'absolute',
          top: 'var(--space-1)',
          right: 'var(--space-1)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          opacity: isHovering ? 1 : 0,
          transition: 'opacity var(--dur-fast) var(--ease-out)',
          pointerEvents: isHovering ? 'auto' : 'none',
          WebkitAppRegion: 'no-drag',
          zIndex: 2
        }}
      >
        <Button
          variant="icon"
          onClick={() => send({ type: 'focus-main' })}
          style={ICON_BUTTON}
          title="Открыть основное окно"
          aria-label="Открыть основное окно"
          data-testid="mini-window-expand"
        >
          <Maximize2 size={ICON.sm} />
        </Button>
        <Button
          variant="icon"
          onClick={() => void window.electronAPI?.closeMiniWindow?.()}
          style={ICON_BUTTON}
          title="Закрыть мини-плеер"
          aria-label="Закрыть мини-плеер"
          data-testid="mini-window-close"
        >
          <X size={ICON.sm} />
        </Button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-3)'
        }}
      >
        <div
          className="mini-artwork"
          style={{
            width: 'var(--mini-artwork-size)',
            height: 'var(--mini-artwork-size)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            borderRadius: 'var(--mini-artwork-radius)',
            border: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--surface-2)'
          }}
        >
          {state.artwork ? (
            <img
              src={state.artwork}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              onError={(event) => {
                event.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <Music2 size={ICON.xl} aria-hidden="true" style={{ color: 'var(--text-faint)' }} />
          )}
        </div>

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)'
          }}
        >
          <div
            className="text-truncate"
            title={hasTrack ? state.title : undefined}
            style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)'
            }}
            data-testid="mini-window-title"
          >
            {hasTrack ? state.title : 'Ничего не играет'}
          </div>
          <div
            className="text-truncate"
            title={hasTrack ? state.artist : undefined}
            style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}
            data-testid="mini-window-artist"
          >
            {hasTrack ? state.artist : 'Запустите трек в основном окне'}
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              WebkitAppRegion: 'no-drag'
            }}
          >
            {/*
              Колонки времени шириной в ступень органа управления: место под
              «0:00» держится постоянным, поэтому переход 0:59 → 1:00 не двигает
              полосу перемотки под курсором.
            */}
            <span
              data-numeric
              style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', minWidth: 'var(--control-sm)' }}
              data-testid="mini-window-elapsed"
            >
              {formatDuration(shownTime)}
            </span>
            {/*
              Полоса центруется флексом, а не отступом сверху. Отступ приходилось
              считать от высоты дорожки, и любая правка одного из двух чисел
              оставляла полосу не по центру своей области нажатия.
            */}
            <div
              style={{
                position: 'relative',
                flex: 1,
                minWidth: 0,
                height: 'var(--space-4)',
                display: 'flex',
                alignItems: 'center'
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  width: '100%',
                  height: 'var(--space-1)',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'var(--surface-3)'
                }}
              >
                <div
                  style={{
                    width: `${progress}%`,
                    height: '100%',
                    borderRadius: 'var(--radius-full)',
                    backgroundColor: accent
                  }}
                />
              </div>
              <input
                type="range"
                /*
                 * `range-bare` — дорожку и заливку рисуют два div выше, а этот
                 * ползунок остаётся прозрачной областью нажатия поверх них.
                 * Прозрачность нуль сама по себе тоже спрятала бы дорожку, но
                 * класс говорит зачем: полоса нарисована рядом, а не отсутствует.
                 */
                className="range-bare"
                min={0}
                max={Math.max(state.duration, 1)}
                step={1}
                value={shownTime}
                disabled={!hasTrack || state.duration === 0}
                onChange={(event) => setScrubTime(Number(event.target.value))}
                onMouseUp={(event) => handleSeek(Number((event.target as HTMLInputElement).value))}
                onKeyUp={(event) => handleSeek(Number((event.target as HTMLInputElement).value))}
                onTouchEnd={(event) => handleSeek(Number((event.target as HTMLInputElement).value))}
                aria-label="Позиция трека"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  margin: 0,
                  opacity: 0,
                  cursor: hasTrack ? 'pointer' : 'default'
                }}
                data-testid="mini-window-seek"
              />
            </div>
            <span
              data-numeric
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--text-faint)',
                minWidth: 'var(--control-sm)',
                textAlign: 'right'
              }}
            >
              {formatDuration(state.duration)}
            </span>
          </div>
        </div>
      </div>

      <div
        className="mini-controls"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          padding: '0 var(--space-3) var(--space-3)',
          WebkitAppRegion: 'no-drag'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
          <Button
            variant="icon"
            onClick={() => send({ type: 'toggle-favorite' })}
            disabled={!hasTrack}
            isActive={state.isFavorite}
            style={{ ...ICON_BUTTON, ...activeTint(state.isFavorite) }}
            title={state.isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
            aria-label={state.isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
            aria-pressed={state.isFavorite}
            data-testid="mini-window-favorite"
          >
            <Heart size={ICON.sm} fill={state.isFavorite ? 'currentColor' : 'none'} />
          </Button>
          <Button
            variant="icon"
            onClick={() => send({ type: 'shuffle' })}
            isActive={state.shuffle}
            style={{ ...ICON_BUTTON, ...activeTint(state.shuffle) }}
            title="Перемешать"
            aria-label="Перемешать"
            aria-pressed={state.shuffle}
            data-testid="mini-window-shuffle"
          >
            <Shuffle size={ICON.sm} />
          </Button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Button
            variant="icon"
            onClick={() => send({ type: 'prev' })}
            style={ICON_BUTTON}
            title="Предыдущий трек"
            aria-label="Предыдущий трек"
            data-testid="mini-window-prev"
          >
            <SkipBack size={ICON.sm} />
          </Button>
          {/*
            Главная кнопка — вариант `primary`: заливку акцентом, блик и ответ на
            наведение отдаёт таблица стилей. Инлайном перебивается только цвет,
            вытянутый из обложки, — рядом с ней окно должно светиться цветом
            трека, а не темы, и об этом цвете CSS ничего не знает.
          */}
          <Button
            variant="primary"
            size="icon"
            onClick={() => send({ type: 'play-pause' })}
            style={{
              borderRadius: 'var(--radius-full)',
              ...(trackAccent ? { backgroundColor: trackAccent } : undefined)
            }}
            title={state.isPlaying ? 'Пауза' : 'Играть'}
            aria-label={state.isPlaying ? 'Пауза' : 'Играть'}
            data-testid="mini-window-play"
          >
            {state.isPlaying ? <Pause size={ICON.md} fill="currentColor" /> : <Play size={ICON.md} fill="currentColor" />}
          </Button>
          <Button
            variant="icon"
            onClick={() => send({ type: 'next' })}
            style={ICON_BUTTON}
            title="Следующий трек"
            aria-label="Следующий трек"
            data-testid="mini-window-next"
          >
            <SkipForward size={ICON.sm} />
          </Button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
          <Button
            variant="icon"
            onClick={() => send({ type: 'repeat' })}
            isActive={state.repeat !== 'off'}
            style={{ ...ICON_BUTTON, ...activeTint(state.repeat !== 'off') }}
            title={
              state.repeat === 'one' ? 'Повтор трека' : state.repeat === 'all' ? 'Повтор очереди' : 'Повтор выключен'
            }
            aria-label="Режим повтора"
            data-testid="mini-window-repeat"
          >
            {state.repeat === 'one' ? <Repeat1 size={ICON.sm} /> : <Repeat size={ICON.sm} />}
          </Button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
            <Button
              variant="icon"
              onClick={() => send({ type: 'volume', value: state.volume > 0 ? 0 : 1 })}
              style={ICON_BUTTON}
              title={state.volume > 0 ? 'Выключить звук' : 'Включить звук'}
              aria-label={state.volume > 0 ? 'Выключить звук' : 'Включить звук'}
              data-testid="mini-window-mute"
            >
              {state.volume > 0 ? <Volume2 size={ICON.sm} /> : <VolumeX size={ICON.sm} />}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.volume}
              onChange={(event) => send({ type: 'volume', value: Number(event.target.value) })}
              aria-label="Громкость"
              style={
                {
                  width: 'var(--control-xl)',
                  // Доля заливки; облик дорожки — правило в global.css.
                  '--range-fill': `${Math.round(state.volume * 100)}%`
                } as React.CSSProperties
              }
              data-testid="mini-window-volume"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
