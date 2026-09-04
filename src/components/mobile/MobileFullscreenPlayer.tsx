import React, { useCallback, useState } from 'react';
import {
  ChevronDown,
  Heart,
  ListMusic,
  Gauge,
  Mic2,
  MoreVertical,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward
} from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { useUIStore } from '../../store/useUIStore';
import { useSwipeDismiss } from '../../hooks/useSwipeDismiss';
import { useDominantColor } from '../../hooks/useDominantColor';
import { Button } from '../common/Button';
import { SeekBar } from '../player/SeekBar';
import { formatRate, TempoPanel } from '../player/TempoControl';
import { Sheet } from './Sheet';
import { KaraokeView } from '../lyrics/KaraokeView';
import { MarqueeText } from '../player/MarqueeText';
import { ICON } from '../../styles/icons';

/**
 * Полноэкранный плеер на телефоне.
 *
 * Что чинится против общего плеера, который показывался здесь раньше.
 *
 * **Транспорт был несимметричен.** В ряду стояли «предыдущий», «играть»,
 * «следующий» и «повтор» — четыре органа, из которых последний только справа.
 * Главная кнопка из-за этого оказывалась левее середины экрана, хотя именно она
 * должна стоять под большим пальцем. Здесь ряд симметричен: перемешать,
 * назад, играть, вперёд, повтор — и «играть» ровно по центру.
 *
 * **Внизу висел одинокий значок темпа** без подписи и без соседей. Управление
 * очередью и скоростью собрано в один ряд с подписями.
 *
 * **Закрытие.** Значок «сжать» заменён на стрелку вниз — тем же движением, что
 * и жест. Жест сохранён (`useSwipeDismiss`), он здесь и был отлажен.
 */
export const MobileFullscreenPlayer: React.FC = () => {
  const isOpen = useUIStore((s) => s.isFullscreenPlayerOpen);
  const setOpen = useUIStore((s) => s.setFullscreenPlayerOpen);
  const toggleQueue = useUIStore((s) => s.toggleQueue);
  const isLyricsOpen = useUIStore((s) => s.isLyricsOpen);
  const setLyricsOpen = useUIStore((s) => s.setLyricsOpen);
  const openTrackActions = useUIStore((s) => s.openTrackActions);

  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const buffered = usePlayerStore((s) => s.buffered);
  const isShuffled = usePlayerStore((s) => s.isShuffled);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((s) => s.cycleRepeatMode);
  const playbackRate = usePlayerStore((s) => s.playbackRate);

  const isFavorite = useLibraryStore((s) => (currentTrack ? s.isFavorite(currentTrack.id) : false));
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);

  const [artworkFailed, setArtworkFailed] = useState(false);
  const [isTempoOpen, setTempoOpen] = useState(false);

  // Изменённая скорость видна прямо на кнопке: забытые 0.65× иначе остаются
  // загадкой — «почему песня звучит не так» без единой подсказки на экране.
  const isTempoModified = Math.abs(playbackRate - 1) > 0.001;

  const close = useCallback(() => setOpen(false), [setOpen]);
  const { offset, isDragging, handlers } = useSwipeDismiss({ enabled: isOpen, onDismiss: close });

  // Свечение под обложкой берётся из неё же: экран приобретает цвет того, что
  // играет, не требуя от нас угадывать настроение.
  const dominant = useDominantColor(currentTrack?.artworkUrl);

  if (!isOpen || !currentTrack) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Плеер"
      className="animate-sheet-up"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-overlay)',
        display: 'flex',
        flexDirection: 'column',
        background: `linear-gradient(180deg, ${dominant} -40%, var(--bg-base) 55%)`,
        paddingTop: 'calc(var(--safe-top) + var(--space-2))',
        paddingBottom: 'calc(var(--safe-bottom) + var(--space-4))',
        paddingLeft: 'calc(var(--safe-left) + var(--space-5))',
        paddingRight: 'calc(var(--safe-right) + var(--space-5))',
        transform: offset > 0 ? `translate3d(0, ${offset}px, 0)` : undefined,
        transition: isDragging ? 'none' : undefined,
        touchAction: 'none'
      }}
      data-testid="mobile-fullscreen-player"
      {...handlers}
    >
      {/* Ухватка: сообщает, что экран смахивается, до того как это попробуют. */}
      <div style={{ display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
        <div
          aria-hidden="true"
          style={{
            width: '36px',
            height: '4px',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--border-strong)'
          }}
        />
      </div>

      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          flexShrink: 0,
          padding: 'var(--space-2) 0'
        }}
      >
        <RoundButton label="Свернуть плеер" onClick={close} testId="mobile-fullscreen-close">
          <ChevronDown size={ICON.xl} aria-hidden="true" />
        </RoundButton>
        <span style={{ flex: 1 }} />
        <RoundButton
          label={`Действия с «${currentTrack.title}»`}
          onClick={() => openTrackActions(currentTrack)}
          testId="mobile-fullscreen-actions"
        >
          <MoreVertical size={ICON.xl} aria-hidden="true" />
        </RoundButton>
      </header>

      {/*
        * Обложка забирает остаток высоты, но не больше квадрата по ширине.
        * `minHeight: 0` обязателен: без него колонка не даёт ей сжаться, и на
        * невысоком экране низ с кнопками уезжает за край.
        */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '1 1 auto',
          minHeight: 0,
          padding: 'var(--space-4) 0'
        }}
      >
        <div
          style={{
            /*
             * Сторона считается от меньшей оси окна, а не от свободного места.
             * `height: 100%` + `aspect-ratio` не работает: явная высота сильнее
             * пропорции, и обложка выходила прямоугольником 312x450.
             */
            width: 'min(82vw, 40vh)',
            height: 'min(82vw, 40vh)',
            flexShrink: 0,
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            background: 'var(--surface-2)',
            boxShadow: 'var(--shadow-lg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          data-testid="mobile-fullscreen-artwork"
        >
          {artworkFailed || !currentTrack.artworkUrl ? (
            <Music2 size={ICON.hero} style={{ color: 'var(--text-faint)' }} aria-hidden="true" />
          ) : (
            <img
              src={currentTrack.artworkUrl}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={() => setArtworkFailed(true)}
            />
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexShrink: 0 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <MarqueeText
            text={currentTrack.title}
            style={{
              fontSize: 'var(--text-xl)',
              lineHeight: 'var(--leading-xl)',
              letterSpacing: 'var(--tracking-xl)',
              fontWeight: 'var(--weight-bold)',
              color: 'var(--text-primary)'
            }}
            data-testid="mobile-fullscreen-title"
          />
          <div
            className="text-truncate"
            style={{
              fontSize: 'var(--text-base)',
              lineHeight: 'var(--leading-base)',
              letterSpacing: 'var(--tracking-base)',
              color: 'var(--text-muted)'
            }}
          >
            {currentTrack.artist}
          </div>
        </div>
        <RoundButton
          label={isFavorite ? 'Убрать из избранного' : 'В избранное'}
          onClick={() => void toggleFavorite(currentTrack)}
          testId="mobile-fullscreen-favorite"
        >
          <Heart
            size={ICON.xl}
            fill={isFavorite ? 'currentColor' : 'none'}
            style={{ color: isFavorite ? 'var(--danger)' : 'var(--text-secondary)' }}
            aria-hidden="true"
          />
        </RoundButton>
      </div>

      <div style={{ flexShrink: 0, padding: 'var(--space-3) 0' }}>
        <SeekBar
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          onSeek={seekTo}
          variant="comfortable"
          idPrefix="mobile-fullscreen"
        />
      </div>

      {/*
        * Симметричный ряд: «играть» ровно по центру экрана, по два спутника с
        * каждой стороны. Прежний ряд был из четырёх кнопок, и главная стояла
        * левее середины.
        */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          padding: 'var(--space-2) 0'
        }}
        data-testid="mobile-fullscreen-transport"
      >
        <RoundButton
          label={isShuffled ? 'Выключить перемешивание' : 'Перемешать'}
          onClick={toggleShuffle}
          active={isShuffled}
          testId="mobile-fullscreen-shuffle"
        >
          <Shuffle size={ICON.lg} aria-hidden="true" />
        </RoundButton>
        <RoundButton label="Предыдущий трек" onClick={() => void prevTrack()} testId="mobile-fullscreen-prev">
          <SkipBack size={ICON.xl} fill="currentColor" aria-hidden="true" />
        </RoundButton>

        {/*
          * Общая кнопка приложения: её акцентный фон живёт в
          * `.wireon-btn[data-variant]`. Инлайновый `background` здесь был бы
          * старше правила и заглушил бы ответ на нажатие и наведение.
          */}
        <Button
          variant="primary"
          onClick={() => void togglePlayPause()}
          aria-label={isPlaying ? 'Пауза' : 'Играть'}
          style={{
            width: '64px',
            height: '64px',
            padding: 0,
            flexShrink: 0,
            borderRadius: 'var(--radius-pill)'
          }}
          data-testid="mobile-fullscreen-play"
        >
          {isPlaying ? (
            <Pause size={ICON['2xl']} fill="currentColor" aria-hidden="true" />
          ) : (
            <Play size={ICON['2xl']} fill="currentColor" aria-hidden="true" />
          )}
        </Button>

        <RoundButton label="Следующий трек" onClick={() => void nextTrack()} testId="mobile-fullscreen-next">
          <SkipForward size={ICON.xl} fill="currentColor" aria-hidden="true" />
        </RoundButton>
        <RoundButton
          label={
            repeatMode === 'one'
              ? 'Повтор одного трека'
              : repeatMode === 'all'
                ? 'Повтор очереди'
                : 'Включить повтор'
          }
          onClick={cycleRepeatMode}
          active={repeatMode !== 'off'}
          testId="mobile-fullscreen-repeat"
        >
          {repeatMode === 'one' ? (
            <Repeat1 size={ICON.lg} aria-hidden="true" />
          ) : (
            <Repeat size={ICON.lg} aria-hidden="true" />
          )}
        </RoundButton>
      </div>

      {/*
        * Нижний ряд: текст песни, темп, очередь — все три с подписями.
        *
        * Текст и темп на телефоне отсутствовали, хотя на ПК есть с самого
        * начала: при переносе плеера я взял только транспорт. Оба компонента
        * общие, переписывать их не понадобилось — не хватало входа.
        */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          flexShrink: 0,
          gap: 'var(--space-2)'
        }}
      >
        <LabelledButton
          icon={<Mic2 size={ICON.md} aria-hidden="true" />}
          label="Текст"
          active={isLyricsOpen}
          onClick={() => setLyricsOpen(!isLyricsOpen)}
          testId="mobile-fullscreen-lyrics"
        />
        {/*
          * Регулятор темпа — то же содержимое, что на ПК, но показанное листом
          * снизу, а не панелью у кнопки.
          *
          * Две беды чинятся разом. Первая: настольная панель прибита к своей
          * кнопке и растёт вбок от неё. Кнопка стоит посреди нижнего ряда, и на
          * экране в 360 px панель шириной 344 уезжала за правый край — половина
          * пресетов и весь переключатель тональности оказывались за кадром.
          * Вторая: подпись «Темп» была отдельным `<span>` рядом с кнопкой, то
          * есть по слову нажимать было некуда — открывался только значок. Здесь
          * подпись внутри кнопки, как у соседей по ряду.
          */}
        <LabelledButton
          icon={<Gauge size={ICON.md} aria-hidden="true" />}
          label={isTempoModified ? formatRate(playbackRate) : 'Темп'}
          active={isTempoOpen || isTempoModified}
          onClick={() => setTempoOpen(true)}
          testId="mobile-fullscreen-tempo"
        />
        <LabelledButton
          icon={<ListMusic size={ICON.md} aria-hidden="true" />}
          label="Очередь"
          onClick={toggleQueue}
          testId="mobile-fullscreen-queue"
        />
      </div>

      <Sheet
        isOpen={isTempoOpen}
        onClose={() => setTempoOpen(false)}
        title="Настроить песню"
        data-testid="mobile-tempo-sheet"
      >
        {/*
          * Поля по бокам — здесь, а не в самом листе: у листа их нет нарочно,
          * там живут списки во всю ширину (меню трека). Пресетам же край экрана
          * впритык не идёт.
          */}
        <div style={{ padding: '0 var(--space-4) var(--space-2)' }}>
          <TempoPanel columns={1} />
        </div>
      </Sheet>

      {isLyricsOpen && <KaraokeView onClose={() => setLyricsOpen(false)} />}
    </div>
  );
};

const LabelledButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  testId: string;
}> = ({ icon, label, onClick, active = false, testId }) => (
  <button
    type="button"
    className="press"
    onClick={onClick}
    aria-pressed={active || undefined}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-2)',
      minHeight: '44px',
      padding: '0 var(--space-3)',
      borderRadius: 'var(--radius-pill)',
      color: active ? 'var(--accent)' : 'var(--text-secondary)',
      fontSize: 'var(--text-sm)',
      lineHeight: 'var(--leading-sm)',
      letterSpacing: 'var(--tracking-sm)',
      cursor: 'pointer'
    }}
    data-testid={testId}
  >
    {icon}
    {label}
  </button>
);

const RoundButton: React.FC<{
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  testId: string;
}> = ({ label, onClick, children, active = false, testId }) => (
  <button
    type="button"
    className="press focus-ring"
    onClick={onClick}
    aria-label={label}
    aria-pressed={active || undefined}
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '48px',
      height: '48px',
      flexShrink: 0,
      borderRadius: 'var(--radius-pill)',
      color: active ? 'var(--accent)' : 'var(--text-secondary)',
      cursor: 'pointer'
    }}
    data-testid={testId}
  >
    {children}
  </button>
);
