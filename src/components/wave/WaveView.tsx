import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Radio, Music2, ListMusic, ThumbsDown, Plus, Loader2, Info } from 'lucide-react';
import { WaveVisualizerOrb } from './WaveVisualizerOrb';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { WaveTuner, describeWaveAxes } from './WaveTuner';
import { WaveSourcePicker } from './WaveSourcePicker';
import { WaveControls } from './WaveControls';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import {
  recommendationEngine,
  explainWavePick,
  UserProfile,
  WaveConfig
} from '../../services/recommendationEngine';
import { SourceBadge } from '../common/SourceBadge';
import { formatDuration } from '../../utils/time';
import { UnifiedTrack } from '../../types/music';
import { WaveSeedKind } from '../../types/store';
import { ICON } from '../../styles/icons';

export interface WaveViewProps {
  className?: string;
}

const SOURCE_TITLES: Record<WaveSeedKind, string> = {
  library: 'из вашей библиотеки',
  discovery: 'из незнакомого',
  artist: 'от одного артиста',
  forgotten: 'из забытого',
  track: 'от одной песни'
};

/** Сколько треков Потока показывать списком. */
const UPCOMING_LIMIT = 6;

export const WaveView: React.FC<WaveViewProps> = ({ className = '' }) => {
  const isNarrow = useMediaQuery('(max-width: 768px)');
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const queueMode = usePlayerStore((s) => s.queueMode);
  const activeWaveMood = usePlayerStore((s) => s.activeWaveMood);
  const activeWaveGenre = usePlayerStore((s) => s.activeWaveGenre);
  const sourceQueue = usePlayerStore((s) => s.sourceQueue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const isReplenishingQueue = usePlayerStore((s) => s.isReplenishingQueue);
  const novelty = usePlayerStore((s) => s.waveNovelty);
  const energy = usePlayerStore((s) => s.waveEnergy);
  const seedKind = usePlayerStore((s) => s.waveSeedKind);
  const seedArtist = usePlayerStore((s) => s.waveSeedArtist);

  const playTrack = usePlayerStore((s) => s.playTrack);
  const syncSourceQueue = usePlayerStore((s) => s.syncSourceQueue);
  const replenishAutoplayQueue = usePlayerStore((s) => s.replenishAutoplayQueue);

  const favorites = useLibraryStore((s) => s.favorites);
  const history = useLibraryStore((s) => s.history);
  const showToast = useUIStore((s) => s.showToast);

  const [isTuneOpen, setIsTuneOpen] = useState(false);
  const [artworkFailed, setArtworkFailed] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);

  const isWaveMode = queueMode === 'my_wave';

  // Профиль нужен, чтобы честно подписать причину под каждым треком: подписи
  // считаются из того же профиля, по которому движок и выбирал.
  useEffect(() => {
    let cancelled = false;
    recommendationEngine
      .buildUserProfile()
      .then((next) => {
        if (!cancelled) setProfile(next);
      })
      .catch(() => {
        if (!cancelled) setProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isWaveMode]);

  useEffect(() => {
    setArtworkFailed(false);
  }, [currentTrack?.id]);

  /**
   * Избранное подменяется живым: его переключают прямо здесь, а перечитывать
   * профиль из базы на каждый лайк — лишняя работа ради той же подписи.
   */
  const reasonProfile = useMemo<UserProfile | null>(() => {
    if (!profile) return null;
    return { ...profile, favoriteTrackIds: new Set(favorites.map((t) => t.id)) };
  }, [profile, favorites]);

  const waveConfig = useMemo<WaveConfig>(
    () => ({
      mood: activeWaveMood,
      genre: activeWaveGenre || undefined,
      novelty,
      energy,
      seedKind,
      seedArtist: seedArtist || undefined
    }),
    [activeWaveMood, activeWaveGenre, novelty, energy, seedKind, seedArtist]
  );

  const reasonFor = useCallback(
    (track: UnifiedTrack): string | null => {
      if (!reasonProfile) return null;
      return explainWavePick(track, reasonProfile, waveConfig).text;
    },
    [reasonProfile, waveConfig]
  );

  const upcomingTracks = sourceQueue.slice(
    currentIndex >= 0 ? currentIndex + 1 : 0,
    (currentIndex >= 0 ? currentIndex + 1 : 0) + UPCOMING_LIMIT
  );

  // Потоку не на что опереться, если слушать ещё нечего. Честнее сказать это
  // прямо, чем выдать «персональную» подборку из случайных треков.
  const hasTaste = favorites.length > 0 || history.length > 0;
  const isColdStart = !hasTaste && (seedKind === 'library' || seedKind === 'forgotten');

  const handleMoreLikeThis = async (track: UnifiedTrack) => {
    try {
      await recommendationEngine.recordFeedback(track, 'more_like_this');
      void replenishAutoplayQueue();
      showToast(`Похожего на «${track.title}» станет больше`, 'success');
    } catch {
      showToast('Не удалось обновить предпочтения', 'error');
    }
  };

  const handleRemoveFromFlow = async (track: UnifiedTrack) => {
    syncSourceQueue(sourceQueue.filter((t) => t.id !== track.id));
    try {
      await recommendationEngine.recordFeedback(track, 'dislike');
      showToast(`«${track.title}» убран из Потока`, 'info');
    } catch {
      showToast('Трек убран, но предпочтения сохранить не удалось', 'error');
    }
  };

  return (
    <div
      className={`wave-view-container animate-view-in ${className}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // На телефоне из восьмисот пикселей высоты почти двести уходило в
        // зазоры между четырьмя блоками — и следующий за подсказкой блок
        // оказывался под полосой плеера. Это экран с одним главным
        // действием, воздух ему нужен, но не столько.
        gap: isNarrow ? 'var(--space-3)' : 'var(--space-5)',
        padding: isNarrow ? 'var(--space-3) var(--space-4)' : 'var(--space-6) var(--space-4)',
        maxWidth: '960px',
        margin: '0 auto',
        width: '100%',
        minHeight: '100%',
        position: 'relative'
      }}
      data-testid="wave-view"
    >
      {/* Фоновое свечение */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: '8%',
          left: '50%',
          transform: 'translateX(-50%)',
          // Не 420 фиксированных: свечение шире экрана раздвигало область
          // прокрутки на полсотни пикселей. Оно декоративное, и подгонять под
          // него ширину страницы незачем.
          width: 'min(420px, 92vw)',
          height: 'min(420px, 92vw)',
          borderRadius: 'var(--radius-full)',
          background: 'radial-gradient(circle, var(--accent-soft) 0%, rgba(0,0,0,0) 70%)',
          // `filter: blur(40px)` здесь был лишним: радиальный градиент и так
          // уходит в прозрачность к 70% радиуса — размывать нечего, зато блюр
          // требовал отдельный слой 420×420 с запасом на радиус размытия и
          // пересчитывался при любом изменении размера.
          opacity: 0.55,
          pointerEvents: 'none',
          zIndex: 0
        }}
      />

      {/* Заголовок */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center',
          gap: 'var(--space-1)',
          // Ширина по колонке, а не по содержимому: у блока с shrink-to-fit
          // ширину задавала самая длинная строка, и подпись под заголовком
          // упиралась в край области, вместо того чтобы перенестись.
          width: '100%',
          zIndex: 1
        }}
      >
        {/*
          * Над заголовком стояла плашка-пилюля «БЕСКОНЕЧНАЯ МУЗЫКА» со звёздочкой.
          * Она не сообщала ничего, чего нет в самом заголовке и в строке под ним,
          * где перечислено, что именно играет. Надзаголовок-капсула, украшающая
          * заголовок, — приём с посадочных страниц, а не элемент интерфейса.
          */}
        {/*
          * На телефоне слово «Поток» уже написано в шапке экрана и подсвечено
          * во вкладке снизу — этот заголовок был третьим повторением подряд и
          * съедал верх экрана, из-за которого главная кнопка уезжала под
          * полосу плеера. На широком окне шапки нет, и заголовок нужен.
          */}
        {!isNarrow && (
          <h1
            style={{
              margin: 0,
              fontSize: 'var(--text-3xl)',
              fontWeight: 'var(--weight-bold)',
              letterSpacing: 'var(--tracking-3xl)',
              color: 'var(--text-primary)'
            }}
          >
            Поток
          </h1>
        )}

        {/* Не обещание, а описание того, что настроено прямо сейчас. */}
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-sm)',
            lineHeight: 1.5,
            color: 'var(--text-secondary)',
            maxWidth: '560px',
            // Жанр и имя артиста приходят извне и бывают без пробелов: пусть
            // рвутся по месту, а не растягивают строку за границу колонки.
            overflowWrap: 'anywhere'
          }}
          data-testid="wave-config-summary"
        >
          Играем {SOURCE_TITLES[seedKind]}
          {seedKind === 'artist' && seedArtist ? ` — ${seedArtist}` : ''}:{' '}
          {describeWaveAxes(novelty, energy)}
          {activeWaveGenre ? `, жанр — ${activeWaveGenre}` : ''}.
        </p>
      </div>

      {/* Шар визуализации */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          // Шар на телефоне занимал половину экрана и выталкивал главную
          // кнопку под полосу плеера — то есть основное действие экрана
          // приходилось искать прокруткой, не зная, что оно там есть.
          maxWidth: isNarrow ? '190px' : '320px',
          // Высота не задаётся: шар сам держит квадрат по доступной ширине.
          // Раньше здесь стояли 280 px при холсте 280×280 — на узком окне холст
          // сжимался по ширине, оставаясь высоким, и слои резались о край.
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1
        }}
      >
        <WaveVisualizerOrb
          mood={activeWaveMood}
          isPlaying={isPlaying}
          width={isNarrow ? 190 : 320}
          height={isNarrow ? 190 : 320}
        />
      </div>

      {/* Что играет сейчас */}
      <div
        style={{
          width: '100%',
          // Одна ширина у всех панелей экрана (680) — раньше «сейчас играет» и
          // управление были на 560, а настройка и поток на 680, и колонка
          // визуально ступенчато расширялась к низу.
          maxWidth: '680px',
          padding: 'var(--space-4) var(--space-5)',
          borderRadius: 'var(--radius-xl)',
          backgroundColor: 'var(--surface-1)',
          border: '1px solid var(--border-accent)',
          boxShadow: 'var(--shadow-lg)',
          // Здесь нет backdrop-filter, и это не упущение: `--surface-1` —
          // непрозрачный hex, размывать под ним нечего. Браузер всё равно
          // поднимал панель в отдельный слой и на каждый кадр гонял блюр по
          // области, результат которого невидим. theme.css это и объявляет:
          // matte, никаких backdrop-filter.
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-4)',
          zIndex: 1
        }}
        data-testid="wave-current-track"
      >
        {currentTrack ? (
          <>
            <div
              style={{
                width: '56px',
                height: '56px',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden',
                backgroundColor: 'var(--surface-sunken)',
                border: '1px solid var(--border-subtle)',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              {artworkFailed || !currentTrack.artworkUrl ? (
                <Music2 size={ICON.xl} style={{ color: 'var(--text-faint)' }} />
              ) : (
                <img
                  src={currentTrack.artworkUrl}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={() => setArtworkFailed(true)}
                />
              )}
            </div>

            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span
                  className="text-truncate"
                  style={{
                    fontSize: 'var(--text-base)',
                    fontWeight: 'var(--weight-semibold)',
                    color: 'var(--text-primary)'
                  }}
                >
                  {currentTrack.title}
                </span>
                <SourceBadge source={currentTrack.source} size="xs" />
              </div>
              <span
                className="text-truncate"
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-secondary)'
                }}
              >
                {currentTrack.artist}
              </span>
              {isWaveMode && reasonFor(currentTrack) && (
                <span
                  style={{
                    marginTop: '2px',
                    fontSize: 'var(--text-xs)',
                    color: 'var(--text-secondary)'
                  }}
                  data-testid="wave-current-reason"
                >
                  {reasonFor(currentTrack)}
                </span>
              )}
            </div>

            <span
              data-numeric
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--text-muted)',
                flexShrink: 0
              }}
            >
              {formatDuration(currentTrack.duration)}
            </span>
          </>
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'var(--space-3)',
              padding: 'var(--space-2)',
              color: 'var(--text-muted)',
              fontSize: 'var(--text-sm)',
              textAlign: 'center'
            }}
          >
            <Radio size={ICON.lg} />
            <span>Настройте параметры ниже и нажмите «Запустить Поток»</span>
          </div>
        )}
      </div>

      {/* Управление */}
      <div style={{ width: '100%', maxWidth: '680px', zIndex: 1 }}>
        <WaveControls onTuneToggle={() => setIsTuneOpen((v) => !v)} isTuneOpen={isTuneOpen} />
      </div>

      {isColdStart && (
        <div
          style={{
            width: '100%',
            maxWidth: '680px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-3)',
            padding: 'var(--space-4)',
            borderRadius: 'var(--radius-lg)',
            backgroundColor: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            zIndex: 1
          }}
          data-testid="wave-cold-start"
        >
          <Info size={ICON.lg} style={{ color: 'var(--text-secondary)', flexShrink: 0, marginTop: '2px' }} />
          <span>
            Пока нечего анализировать: в библиотеке и истории нет треков, поэтому Поток будет
            обычным, а не вашим. Послушайте несколько песен или переключите источник на
            «Незнакомое».
          </span>
        </div>
      )}

      {/* Настройка Потока */}
      {isTuneOpen && (
        <div
          // Панель раскрывается сразу под кнопкой «Настроить», поэтому и падение
          // сверху, а не подъём снизу: подъём отвязывал её от того, что нажали.
          className="animate-drop-in"
          style={{
            width: '100%',
            maxWidth: '680px',
            padding: 'var(--space-5)',
            borderRadius: 'var(--radius-xl)',
            backgroundColor: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
            boxShadow: 'var(--shadow-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-5)',
            zIndex: 1
          }}
          data-testid="wave-tuner-panel"
        >
          <WaveSourcePicker />
          <div style={{ height: '1px', backgroundColor: 'var(--border-subtle)' }} aria-hidden="true" />
          <WaveTuner />
        </div>
      )}

      {/* Поток дальше */}
      {isWaveMode && (upcomingTracks.length > 0 || isReplenishingQueue) && (
        <div
          style={{
            width: '100%',
            maxWidth: '680px',
            padding: 'var(--space-4) var(--space-5)',
            borderRadius: 'var(--radius-xl)',
            backgroundColor: 'var(--surface-1)',
            border: '1px solid var(--border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
            zIndex: 1
          }}
          data-testid="wave-upcoming-flow"
        >
          {/*
            * Капс с разгонкой стоял на всей строке, поэтому вложенное «Подбираем»
            * приходилось откручивать назад тремя свойствами. Регистр принадлежит
            * подписи — и отменять его больше не нужно.
            */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              fontSize: 'var(--text-sm)',
              color: 'var(--text-muted)'
            }}
          >
            <ListMusic size={ICON.sm} />
            <span className="section-label">Далее в Потоке</span>
            {isReplenishingQueue && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-1)',
                  marginLeft: 'auto'
                }}
                data-testid="wave-flow-loading"
              >
                <Loader2 size={ICON.xs} className="animate-spin" />
                Подбираем
              </span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            {upcomingTracks.map((track, i) => {
              const reason = reasonFor(track);
              return (
                <div
                  key={`${track.id}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-2) var(--space-3)',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: 'var(--surface-2)'
                  }}
                  data-testid={`wave-upcoming-item-${track.id}`}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => void playTrack(track, sourceQueue, currentIndex + 1 + i)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void playTrack(track, sourceQueue, currentIndex + 1 + i);
                      }
                    }}
                    className="press"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-3)',
                      flex: 1,
                      minWidth: 0,
                      cursor: 'pointer'
                    }}
                    aria-label={`Включить «${track.title}»`}
                  >
                    <div
                      style={{
                        width: '32px',
                        height: '32px',
                        borderRadius: 'var(--radius-xs)',
                        overflow: 'hidden',
                        backgroundColor: 'var(--surface-sunken)',
                        flexShrink: 0
                      }}
                    >
                      {track.artworkUrl ? (
                        <img
                          src={track.artworkUrl}
                          alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        />
                      ) : (
                        <Music2 size={ICON.md} style={{ color: 'var(--text-faint)', margin: '8px' }} />
                      )}
                    </div>

                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                      <span
                        className="text-truncate"
                        style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}
                        title={track.title}
                      >
                        {track.title}
                      </span>
                      <span
                        className="text-truncate"
                        style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}
                        title={track.artist}
                      >
                        {track.artist}
                        {reason ? ` · ${reason}` : ''}
                      </span>
                    </div>
                  </div>

                  <SourceBadge source={track.source} size="xs" />

                  <span data-numeric style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    {formatDuration(track.duration)}
                  </span>

                  <button
                    type="button"
                    onClick={() => void handleMoreLikeThis(track)}
                    title="Больше такого в Потоке"
                    aria-label={`Больше такого, как «${track.title}»`}
                    className="press"
                    style={{
                      display: 'inline-flex',
                      padding: 'var(--space-1)',
                      borderRadius: 'var(--radius-xs)',
                      border: 'none',
                      // `background: transparent` убран: у <button> фон и так
                      // снят в ресете (§1), зато инлайновое объявление старше
                      // правила таблицы — и `.press:hover` до кнопки не
                      // доходил. Кнопка объявляла переход фона и не менялась.
                      color: 'var(--text-muted)',
                      cursor: 'pointer'
                    }}
                    data-testid={`wave-item-more-${track.id}`}
                  >
                    <Plus size={ICON.sm} />
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleRemoveFromFlow(track)}
                    title="Убрать из Потока и больше не предлагать"
                    aria-label={`Убрать «${track.title}» из Потока`}
                    className="press"
                    style={{
                      display: 'inline-flex',
                      padding: 'var(--space-1)',
                      borderRadius: 'var(--radius-xs)',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer'
                    }}
                    data-testid={`wave-item-remove-${track.id}`}
                  >
                    <ThumbsDown size={ICON.sm} />
                  </button>
                </div>
              );
            })}
          </div>

          {reasonProfile && upcomingTracks.length > 0 && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
              Подписи показывают, почему трек попал в Поток.
            </span>
          )}
        </div>
      )}

      {/* Поток включён, а очередь пуста — это состояние тоже надо объяснить. */}
      {isWaveMode && !isReplenishingQueue && upcomingTracks.length === 0 && currentTrack && (
        <div
          style={{
            width: '100%',
            maxWidth: '680px',
            padding: 'var(--space-4)',
            borderRadius: 'var(--radius-lg)',
            backgroundColor: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)',
            fontSize: 'var(--text-sm)',
            color: 'var(--text-secondary)',
            textAlign: 'center',
            zIndex: 1
          }}
          data-testid="wave-empty-stream"
        >
          Поток закончился — по этим настройкам ничего больше не нашлось. Сдвиньте «Знакомое или
          новое» или снимите жанр.
        </div>
      )}
    </div>
  );
};
