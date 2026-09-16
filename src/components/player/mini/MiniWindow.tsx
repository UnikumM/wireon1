import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  Heart,
  Maximize2,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shapes,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  X
} from 'lucide-react';
import type { MiniPlayerCommand, MiniPlayerState } from '../../../types/electron';
import { formatDuration } from '../../../utils/time';
import { ICON } from '../../../styles/icons';
import { usePlayerLayoutStore } from '../../../store/usePlayerLayoutStore';
import { miniSkinVars } from '../../../styles/miniSkins';
import { isMiniFormId, MINI_FORM_IDS, MINI_FORMS, type MiniFormId } from '../../../styles/miniForms';

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

/** Шаг громкости на одно деление колёсика. */
const WHEEL_VOLUME_STEP = 0.05;
/** Сколько висит плашка громкости после последнего деления. */
const VOLUME_HUD_MS = 900;
/** Задержка сворачивания «Острова»: курсор, соскочивший на пиксель, не должен схлопывать плеер. */
const ISLAND_COLLAPSE_DELAY_MS = 220;

/**
 * Время между снимками.
 *
 * Основное окно шлёт целые секунды раз в полсекунды, и полоса прогресса шагала
 * бы рывками раз в секунду. Здесь время досчитывается по часам, пока играет, а
 * пришедший снимок только поправляет его — и назад не дёргает: снимок округлён
 * вниз, настоящее время лежит где-то в его секунде.
 */
function useSmoothTime(time: number, playing: boolean, duration: number): number {
  const anchor = useRef({ time, at: Date.now(), seen: time, playing });
  const [, tick] = useReducer((n: number) => n + 1, 0);

  if (anchor.current.seen !== time || anchor.current.playing !== playing) {
    const a = anchor.current;
    const predicted = a.playing ? a.time + (Date.now() - a.at) / 1000 : a.time;
    const withinSecond = playing && predicted >= time && predicted < time + 1;
    anchor.current = { time: withinSecond ? predicted : time, at: Date.now(), seen: time, playing };
  }

  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(tick, 100);
    return () => window.clearInterval(id);
  }, [playing]);

  const a = anchor.current;
  const value = playing ? a.time + (Date.now() - a.at) / 1000 : a.time;
  return duration > 0 ? Math.min(value, duration) : value;
}

/** Прошлое значение — чтобы анимация лайка играла на нажатие, а не при открытии окна. */
function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>();
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref.current;
}

interface FormProps {
  state: MiniPlayerState;
  hasTrack: boolean;
  time: number;
  progress: number;
  scrubbing: boolean;
  onScrub: (value: number) => void;
  onSeek: (value: number) => void;
  heartPop: number;
  expanded: boolean;
}

/* --------------------------------------------------------------------------
 * Общие части
 * ------------------------------------------------------------------------ */

const Artwork: React.FC<{ src: string | null; className?: string }> = ({ src, className = '' }) => (
  <div className={`mini-artwork ${className}`} aria-hidden="true">
    {src ? (
      // Ключ по адресу: новая обложка монтируется заново и проявляется, а не
      // подменяется в той же рамке без перехода.
      <img
        key={src}
        className="mini-art-img"
        src={src}
        alt=""
        onError={(event) => {
          event.currentTarget.style.display = 'none';
        }}
      />
    ) : (
      <Music2 size={ICON.lg} className="mini-art-fallback" />
    )}
  </div>
);

const TitleBlock: React.FC<{ state: MiniPlayerState; hasTrack: boolean; tone?: 'media' }> = ({
  state,
  hasTrack,
  tone
}) => (
  <div className="mini-titles" data-tone={tone}>
    {/* Ключ по названию: смена трека въезжает снизу, а не мигает текстом на месте. */}
    <div
      key={`t-${state.title}`}
      className="mini-title text-truncate"
      title={hasTrack ? state.title : undefined}
      data-testid="mini-window-title"
    >
      {hasTrack ? state.title : 'Ничего не играет'}
    </div>
    <div
      key={`a-${state.artist}`}
      className="mini-subtitle text-truncate"
      title={hasTrack ? state.artist : undefined}
      data-testid="mini-window-artist"
    >
      {hasTrack ? state.artist : 'Запустите трек в основном окне'}
    </div>
  </div>
);

/** Три полоски, которые пляшут, пока играет. Остановка — пауза анимации, а не её снятие. */
const Equalizer: React.FC = () => (
  <span className="mini-eq" aria-hidden="true">
    <span className="mini-eq-bar" />
    <span className="mini-eq-bar" />
    <span className="mini-eq-bar" />
    <span className="mini-eq-bar" />
  </span>
);

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  size?: 'sm' | 'md';
}

const IconButton: React.FC<IconButtonProps> = ({ active, size = 'sm', className = '', children, ...rest }) => (
  <button
    type="button"
    className={`mini-btn ${className}`}
    data-size={size}
    data-active={active ? 'true' : undefined}
    {...rest}
  >
    {children}
  </button>
);

const PlayButton: React.FC<{ playing: boolean; size?: 'md' | 'lg' }> = ({ playing, size = 'md' }) => (
  <button
    type="button"
    className="mini-play"
    data-size={size}
    onClick={() => send({ type: 'play-pause' })}
    title={playing ? 'Пауза' : 'Играть'}
    aria-label={playing ? 'Пауза' : 'Играть'}
    data-testid="mini-window-play"
  >
    {/* Ключ по состоянию: значок сменяется поворотом, а не скачком. */}
    <span key={playing ? 'pause' : 'play'} className="mini-play-icon">
      {playing ? (
        <Pause size={size === 'lg' ? ICON.lg : ICON.md} fill="currentColor" />
      ) : (
        <Play size={size === 'lg' ? ICON.lg : ICON.md} fill="currentColor" />
      )}
    </span>
  </button>
);

const Transport: React.FC<{ playing: boolean; size?: 'md' | 'lg' }> = ({ playing, size = 'md' }) => (
  <div className="mini-transport">
    <IconButton
      size={size === 'lg' ? 'md' : 'sm'}
      onClick={() => send({ type: 'prev' })}
      title="Предыдущий трек"
      aria-label="Предыдущий трек"
      data-testid="mini-window-prev"
    >
      <SkipBack size={size === 'lg' ? ICON.md : ICON.sm} fill="currentColor" />
    </IconButton>
    <PlayButton playing={playing} size={size} />
    <IconButton
      size={size === 'lg' ? 'md' : 'sm'}
      onClick={() => send({ type: 'next' })}
      title="Следующий трек"
      aria-label="Следующий трек"
      data-testid="mini-window-next"
    >
      <SkipForward size={size === 'lg' ? ICON.md : ICON.sm} fill="currentColor" />
    </IconButton>
  </div>
);

const FavoriteButton: React.FC<{ state: MiniPlayerState; hasTrack: boolean; pop: number }> = ({
  state,
  hasTrack,
  pop
}) => (
  <IconButton
    onClick={() => send({ type: 'toggle-favorite' })}
    disabled={!hasTrack}
    active={state.isFavorite}
    className="mini-heart"
    data-pop={pop > 0 && state.isFavorite ? String(pop) : undefined}
    title={state.isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
    aria-label={state.isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
    aria-pressed={state.isFavorite}
    data-testid="mini-window-favorite"
  >
    <Heart key={`h-${pop}`} size={ICON.sm} fill={state.isFavorite ? 'currentColor' : 'none'} />
  </IconButton>
);

/** Полоса перемотки: дорожку рисуют div, прозрачный ползунок сверху ловит нажатия. */
const SeekBar: React.FC<Pick<FormProps, 'state' | 'hasTrack' | 'time' | 'progress' | 'onScrub' | 'onSeek'> & {
  withTimes?: boolean;
}> = ({ state, hasTrack, time, progress, onScrub, onSeek, withTimes = true }) => (
  <div className="mini-seek">
    {withTimes && (
      <span data-numeric className="mini-time" data-testid="mini-window-elapsed">
        {formatDuration(time)}
      </span>
    )}
    <div className="mini-progress">
      <div className="mini-progress-track" aria-hidden="true">
        <div className="mini-progress-fill" style={{ width: `${progress}%` }} />
      </div>
      <input
        type="range"
        className="range-bare mini-seek-input"
        min={0}
        max={Math.max(state.duration, 1)}
        step={1}
        value={Math.floor(time)}
        disabled={!hasTrack || state.duration === 0}
        onChange={(event) => onScrub(Number(event.target.value))}
        onMouseUp={(event) => onSeek(Number((event.target as HTMLInputElement).value))}
        onKeyUp={(event) => onSeek(Number((event.target as HTMLInputElement).value))}
        onTouchEnd={(event) => onSeek(Number((event.target as HTMLInputElement).value))}
        aria-label="Позиция трека"
        data-testid="mini-window-seek"
      />
    </div>
    {withTimes && (
      <span data-numeric className="mini-time" data-align="end">
        {formatDuration(state.duration)}
      </span>
    )}
  </div>
);

/** Тонкая линия прогресса без ручки — для форм, где перемотке нет места. */
const ProgressLine: React.FC<{ progress: number }> = ({ progress }) => (
  <div className="mini-line" aria-hidden="true">
    <div className="mini-line-fill" style={{ width: `${progress}%` }} />
  </div>
);

const VolumeIcon: React.FC<{ volume: number }> = ({ volume }) =>
  volume <= 0 ? <VolumeX size={ICON.sm} /> : volume < 0.5 ? <Volume1 size={ICON.sm} /> : <Volume2 size={ICON.sm} />;

const WindowActions: React.FC<{ formId: MiniFormId }> = ({ formId }) => {
  const nextForm = MINI_FORM_IDS[(MINI_FORM_IDS.indexOf(formId) + 1) % MINI_FORM_IDS.length];
  return (
    <div className="mini-actions">
      <IconButton
        onClick={() => send({ type: 'set-form', form: nextForm })}
        title={`Форма: ${MINI_FORMS[formId].name} → ${MINI_FORMS[nextForm].name}`}
        aria-label={`Сменить форму на «${MINI_FORMS[nextForm].name}»`}
        data-testid="mini-window-form"
      >
        <Shapes size={ICON.xs} />
      </IconButton>
      <IconButton
        onClick={() => send({ type: 'focus-main' })}
        title="Открыть основное окно"
        aria-label="Открыть основное окно"
        data-testid="mini-window-expand"
      >
        <Maximize2 size={ICON.xs} />
      </IconButton>
      <IconButton
        onClick={() => void window.electronAPI?.closeMiniWindow?.()}
        title="Закрыть мини-плеер"
        aria-label="Закрыть мини-плеер"
        data-testid="mini-window-close"
      >
        <X size={ICON.xs} />
      </IconButton>
    </div>
  );
};

/* --------------------------------------------------------------------------
 * Формы
 * ------------------------------------------------------------------------ */

/**
 * «Карточка» — всё сразу. Раскладка та же, что была, но окно больше не
 * сужается: ползунок громкости стоит в своей колонке фиксированной ширины.
 */
const CardForm: React.FC<FormProps> = (props) => {
  const { state, hasTrack, heartPop } = props;
  return (
    <div className="mini-card">
      <div className="mini-card-head">
        <Artwork src={state.artwork} />
        <div className="mini-card-info">
          <TitleBlock state={state} hasTrack={hasTrack} />
          <SeekBar {...props} />
        </div>
      </div>

      <div className="mini-controls">
        <div className="mini-group">
          <FavoriteButton state={state} hasTrack={hasTrack} pop={heartPop} />
          <IconButton
            onClick={() => send({ type: 'shuffle' })}
            active={state.shuffle}
            title="Перемешать"
            aria-label="Перемешать"
            aria-pressed={state.shuffle}
            data-testid="mini-window-shuffle"
          >
            <Shuffle size={ICON.sm} />
          </IconButton>
        </div>

        <Transport playing={state.isPlaying} />

        <div className="mini-group" data-align="end">
          <IconButton
            onClick={() => send({ type: 'repeat' })}
            active={state.repeat !== 'off'}
            title={
              state.repeat === 'one' ? 'Повтор трека' : state.repeat === 'all' ? 'Повтор очереди' : 'Повтор выключен'
            }
            aria-label="Режим повтора"
            data-testid="mini-window-repeat"
          >
            {state.repeat === 'one' ? <Repeat1 size={ICON.sm} /> : <Repeat size={ICON.sm} />}
          </IconButton>
          <IconButton
            onClick={() => send({ type: 'volume', value: state.volume > 0 ? 0 : 1 })}
            title={state.volume > 0 ? 'Выключить звук' : 'Включить звук'}
            aria-label={state.volume > 0 ? 'Выключить звук' : 'Включить звук'}
            data-testid="mini-window-mute"
          >
            <VolumeIcon volume={state.volume} />
          </IconButton>
          <input
            type="range"
            className="mini-volume"
            min={0}
            max={1}
            step={0.01}
            value={state.volume}
            onChange={(event) => send({ type: 'volume', value: Number(event.target.value) })}
            aria-label="Громкость"
            style={{ '--range-fill': `${Math.round(state.volume * 100)}%` } as React.CSSProperties}
            data-testid="mini-window-volume"
          />
        </div>
      </div>
    </div>
  );
};

/**
 * «Остров» — пилюля, которая раскрывается в плеер, пока над ней курсор.
 *
 * Два слоя лежат друг на друге и меняются прозрачностью, а фигура под ними
 * перетекает из одного размера в другой пружиной. Раскрытый слой въезжает с
 * задержкой по строкам — сначала название, потом полоса, потом кнопки.
 */
const IslandForm: React.FC<FormProps> = (props) => {
  const { state, hasTrack, heartPop } = props;
  return (
    <>
      <div className="mini-island-pill" aria-hidden={props.expanded}>
        <Artwork src={state.artwork} className="mini-island-art" />
        <span className="mini-island-title text-truncate">{hasTrack ? state.title : 'Ничего не играет'}</span>
        <Equalizer />
      </div>
      <div className="mini-island-full" aria-hidden={!props.expanded}>
        <div className="mini-island-head mini-stagger">
          <Artwork src={state.artwork} />
          <TitleBlock state={state} hasTrack={hasTrack} />
          <FavoriteButton state={state} hasTrack={hasTrack} pop={heartPop} />
        </div>
        <div className="mini-stagger">
          <SeekBar {...props} />
        </div>
        <div className="mini-controls mini-stagger">
          <IconButton
            onClick={() => send({ type: 'shuffle' })}
            active={state.shuffle}
            title="Перемешать"
            aria-label="Перемешать"
            aria-pressed={state.shuffle}
          >
            <Shuffle size={ICON.sm} />
          </IconButton>
          <Transport playing={state.isPlaying} />
          <IconButton
            onClick={() => send({ type: 'repeat' })}
            active={state.repeat !== 'off'}
            title={state.repeat === 'one' ? 'Повтор трека' : state.repeat === 'all' ? 'Повтор очереди' : 'Повтор выключен'}
            aria-label="Режим повтора"
          >
            {state.repeat === 'one' ? <Repeat1 size={ICON.sm} /> : <Repeat size={ICON.sm} />}
          </IconButton>
        </div>
      </div>
    </>
  );
};

/** «Полоса» — одна строка. Громкость — колёсиком над любой её частью. */
const BarForm: React.FC<FormProps> = ({ state, hasTrack, progress, heartPop }) => (
  <div className="mini-bar">
    <Artwork src={state.artwork} />
    <div className="mini-bar-info">
      <TitleBlock state={state} hasTrack={hasTrack} />
    </div>
    <Equalizer />
    <FavoriteButton state={state} hasTrack={hasTrack} pop={heartPop} />
    <div className="mini-controls">
      <Transport playing={state.isPlaying} />
    </div>
    <ProgressLine progress={progress} />
  </div>
);

/** «Обложка» — картинка во всю фигуру; кнопки проступают поверх при наведении. */
const CoverForm: React.FC<FormProps> = ({ state, hasTrack, progress, heartPop }) => (
  <div className="mini-cover">
    <Artwork src={state.artwork} className="mini-cover-art" />
    <div className="mini-cover-scrim" aria-hidden="true" />
    <div className="mini-cover-eq">
      <Equalizer />
    </div>
    <div className="mini-cover-controls mini-controls">
      <Transport playing={state.isPlaying} size="lg" />
    </div>
    <div className="mini-cover-foot">
      <TitleBlock state={state} hasTrack={hasTrack} tone="media" />
      <FavoriteButton state={state} hasTrack={hasTrack} pop={heartPop} />
    </div>
    <ProgressLine progress={progress} />
  </div>
);

/** Кольцо прогресса по краю «Диска». Длина окружности считается от радиуса в viewBox. */
const RING_RADIUS = 47;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const DiscForm: React.FC<FormProps> = ({ state, hasTrack, progress, heartPop }) => (
  // Названию на круге места нет — оно в подсказке у всей пластинки.
  <div className="mini-disc" title={hasTrack ? `${state.title} — ${state.artist}` : undefined}>
    <Artwork src={state.artwork} className="mini-disc-art" />
    <div className="mini-disc-hole" aria-hidden="true" />
    <svg className="mini-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle className="mini-ring-track" cx="50" cy="50" r={RING_RADIUS} />
      <circle
        className="mini-ring-fill"
        cx="50"
        cy="50"
        r={RING_RADIUS}
        strokeDasharray={RING_LENGTH}
        strokeDashoffset={RING_LENGTH * (1 - progress / 100)}
      />
    </svg>
    <div className="mini-disc-controls mini-controls">
      <Transport playing={state.isPlaying} />
      <FavoriteButton state={state} hasTrack={hasTrack} pop={heartPop} />
    </div>
  </div>
);

const FORM_COMPONENTS: Record<MiniFormId, React.FC<FormProps>> = {
  card: CardForm,
  island: IslandForm,
  bar: BarForm,
  cover: CoverForm,
  disc: DiscForm
};

/**
 * The always-on-top mini player, rendered in its own `BrowserWindow`.
 *
 * It owns no playback: audio lives in the main window, so this is a remote
 * control. State arrives as snapshots over `onMiniState` and every interaction
 * leaves as a `MiniPlayerCommand`. That split is what keeps the two windows from
 * ever disagreeing about what is playing — there is only one player.
 *
 * Окно прозрачное; то, что человек видит, — фигура формы внутри него. Поле вокруг
 * фигуры пропускает клики к окнам под ним, пока курсор не войдёт в саму фигуру.
 */
export const MiniWindow: React.FC = () => {
  const [state, setState] = useState<MiniPlayerState>(EMPTY_STATE);
  // While a drag is in progress the incoming snapshots would fight the thumb, so
  // the local value wins until the pointer is released.
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hudUntil, setHudUntil] = useState(0);
  const [heartPop, setHeartPop] = useState(0);
  const requestedRef = useRef(false);
  const collapseTimer = useRef<number | null>(null);
  const draggingRef = useRef(false);

  /*
   * Облик и форма приходят из двух мест, и у каждого своя работа.
   *
   * Стор — то, что известно до первого снимка: мини-окно рисует свой документ и
   * читает настройки само (`src/main.tsx`), поэтому нужный вид стоит уже в
   * первом кадре, без вспышки вида по умолчанию.
   *
   * Снимок — то, что меняется при открытом окне: настройка живёт в основном окне,
   * это другой процесс отрисовки со своей копией сторов, и без провода выбор
   * доехал бы сюда только к следующему запуску.
   */
  const localSkin = usePlayerLayoutStore((s) => s.miniSkinId);
  const localForm = usePlayerLayoutStore((s) => s.miniFormId);
  const skinId = state.skin ?? localSkin;
  const formId: MiniFormId = isMiniFormId(state.form) ? state.form : localForm;

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

  // Размер окна идёт за формой: у каждой формы он свой и других не бывает.
  useEffect(() => {
    void window.electronAPI?.setMiniForm?.(formId);
  }, [formId]);

  /*
   * Отклик — на нажатие, а не на факт «трек в избранном».
   *
   * Сравнивается пара «трек и лайк»: иначе первый же снимок открытого окна
   * играл бы анимацию на песне, добавленной вчера, и она же повторялась бы при
   * каждом переключении на такую песню.
   */
  const previousFavorite = usePrevious(`${state.title}|${state.isFavorite}`);
  useEffect(() => {
    if (previousFavorite === `${state.title}|false` && state.isFavorite) setHeartPop((n) => n + 1);
  }, [previousFavorite, state.title, state.isFavorite]);

  const handleSeek = useCallback((value: number) => {
    setScrubTime(null);
    send({ type: 'seek', value });
  }, []);

  const hasTrack = state.title !== '';
  const smooth = useSmoothTime(state.currentTime, state.isPlaying && scrubTime === null, state.duration);
  const time = scrubTime ?? smooth;
  const progress = state.duration > 0 ? Math.min(100, (time / state.duration) * 100) : 0;

  const setClickThrough = (ignore: boolean) => window.electronAPI?.setMiniIgnoreMouse?.(ignore);

  const handleEnter = () => {
    setClickThrough(false);
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    setExpanded(true);
  };

  const handleLeave = () => {
    if (draggingRef.current) return;
    setClickThrough(true);
    collapseTimer.current = window.setTimeout(() => {
      collapseTimer.current = null;
      setExpanded(false);
    }, ISLAND_COLLAPSE_DELAY_MS);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input')) return;
    draggingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    window.electronAPI?.miniDragStart?.();
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    window.electronAPI?.miniDragEnd?.();
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0) return;
    const next = Math.min(1, Math.max(0, state.volume + (event.deltaY < 0 ? WHEEL_VOLUME_STEP : -WHEEL_VOLUME_STEP)));
    const rounded = Math.round(next * 100) / 100;
    send({ type: 'volume', value: rounded });
    // Громкость в снимке приедет через полсекунды; плашка показывает то, что
    // человек только что накрутил, не дожидаясь её.
    setState((current) => ({ ...current, volume: rounded }));
    setHudUntil(Date.now() + VOLUME_HUD_MS);
  };

  const [, forceHud] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (hudUntil === 0) return;
    const id = window.setTimeout(forceHud, Math.max(0, hudUntil - Date.now()) + 16);
    return () => window.clearTimeout(id);
  }, [hudUntil]);
  const hudVisible = hudUntil > Date.now();

  const Form = FORM_COMPONENTS[formId];
  const accent = state.accent ?? 'var(--accent)';

  return (
    <div
      className="mini-stage"
      style={
        {
          // Переменные облика читаются фигурой: цвет, рамка, радиус, обложка.
          ...miniSkinVars(skinId),
          '--mini-accent': accent
        } as React.CSSProperties
      }
      data-mini-skin={skinId}
      data-mini-form={formId}
      data-playing={state.isPlaying ? 'true' : 'false'}
      data-testid="mini-window"
    >
      <div
        className="mini-shape"
        data-expanded={expanded ? 'true' : 'false'}
        onPointerEnter={handleEnter}
        onPointerLeave={handleLeave}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest('button, input')) send({ type: 'focus-main' });
        }}
        onWheel={handleWheel}
        style={{
          backgroundColor: 'var(--mini-tint)',
          backgroundImage: 'var(--mini-overlay)',
          border: 'var(--mini-border)',
          boxShadow: 'var(--mini-shadow)',
          backdropFilter: 'var(--mini-blur)'
        }}
      >
        <div className="mini-glow" aria-hidden="true" />
        <Form
          state={state}
          hasTrack={hasTrack}
          time={time}
          progress={progress}
          scrubbing={scrubTime !== null}
          onScrub={setScrubTime}
          onSeek={handleSeek}
          heartPop={heartPop}
          expanded={expanded}
        />
        <WindowActions formId={formId} />
        <div className="mini-hud" data-visible={hudVisible ? 'true' : 'false'} aria-hidden="true">
          <VolumeIcon volume={state.volume} />
          <div className="mini-hud-track">
            <div className="mini-hud-fill" style={{ width: `${Math.round(state.volume * 100)}%` }} />
          </div>
          <span data-numeric className="mini-hud-value">
            {Math.round(state.volume * 100)}
          </span>
        </div>
      </div>
    </div>
  );
};
