import React, { useEffect, useRef, useState } from 'react';
import { Music2, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUIStore } from '../../store/useUIStore';
import { ICON } from '../../styles/icons';
import { MarqueeText } from '../player/MarqueeText';
import { SeekBar } from '../player/SeekBar';
import { VolumeSlider } from '../common/VolumeSlider';

/**
 * Полоса играющего трека на телефоне.
 *
 * Против прежней полосы здесь три осознанных решения.
 *
 * **Плавающая плашка, а не приклеенная полоса.** Отступ по бокам и скруглённые
 * углы отделяют её от нижней панели. Раньше две полосы стояли впритык и
 * читались как одна широкая деталь неясного назначения.
 *
 * **Одна кнопка вместо трёх.** Были «предыдущий», «играть» и «следующий»,
 * причём «играть» — светлый круг 48 px, а соседи — тонкие контурные значки:
 * три органа управления разного веса в ряд. На 360 px они забирали 130 px,
 * то есть больше трети ширины, у названия трека. Осталось play/pause;
 * перемотка живёт в полноэкранном плеере, куда ведёт нажатие на саму плашку.
 *
 * **Прогресс — волосяная линия по низу.** Она не требует места и отвечает на
 * единственный вопрос, который к полосе есть: сколько ещё играть.
 */
export const MobilePlayerBar: React.FC = () => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlayPause = usePlayerStore((s) => s.togglePlayPause);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const setFullscreenPlayerOpen = useUIStore((s) => s.setFullscreenPlayerOpen);
  const buffered = usePlayerStore((s) => s.buffered);
  const seekTo = usePlayerStore((s) => s.seekTo);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const volume = usePlayerStore((s) => s.volume);
  const isMuted = usePlayerStore((s) => s.isMuted);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);

  const [artworkFailed, setArtworkFailed] = useState(false);

  /*
   * Полоса смотрит на свою ширину, а не на то, телефон это или нет.
   *
   * Телефонный вид включается и в узком окне на ПК — так и было задумано, — но
   * там у человека мышь, и он вправе ждать громкость, перемотку и переключение
   * треков. На 360 px их негде разместить: три кнопки съедают треть ширины у
   * названия. Поэтому решает не устройство, а место: есть — показываем, нет —
   * прячем. На телефоне порог не достигается никогда, на сжатом окне ПК —
   * достигается сразу.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;

    /*
     * Замер сразу, не дожидаясь наблюдателя.
     *
     * `ResizeObserver` сообщает об **изменении** размера, а первое сообщение
     * приходит не всегда: в свёрнутой панели предпросмотра и в фоновой вкладке
     * его доставка привязана к отрисовке и может не случиться вовсе. Тогда
     * ширина навсегда оставалась нулём, и кнопки не появлялись даже в широком
     * окне. Один синхронный замер это закрывает; наблюдатель дальше следит за
     * изменениями.
     */
    setWidth(element.getBoundingClientRect().width);

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
    /*
     * Зависимость от играющего трека обязательна. Пока играть нечего, полосы в
     * разметке нет вовсе, и наблюдатель, запущенный с пустым списком
     * зависимостей, не находил элемента и больше не повторялся: ширина навсегда
     * оставалась нулём, а вместе с ней пропадали перемотка, соседние треки и
     * громкость даже в широком окне.
     */
  }, [currentTrack]);

  const hasRoom = width >= ROOMY_BAR_WIDTH_PX;

  // Пустая полоса не рисуется вовсе. Прежняя показывала «Ничего не играет» с
  // переносом на две строки и мёртвыми кнопками — занимала место, отвечая на
  // вопрос, которого никто не задавал.
  if (!currentTrack) return null;

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div
      ref={rootRef}
      style={{
        flexShrink: 0,
        margin: '0 var(--space-2) var(--space-2)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-3)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-md)',
        overflow: 'hidden'
      }}
      data-testid="mobile-player-bar"
    >
      <div style={{ display: 'flex', alignItems: 'center', height: '56px' }}>
        <button
          type="button"
          className="press"
          onClick={() => setFullscreenPlayerOpen(true)}
          aria-label={`Открыть плеер: ${currentTrack.title}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            flex: 1,
            minWidth: 0,
            height: '100%',
            padding: '0 var(--space-2)',
            textAlign: 'left',
            cursor: 'pointer'
          }}
          data-testid="mobile-player-open-fullscreen"
        >
          <span
            style={{
              width: '44px',
              height: '44px',
              flexShrink: 0,
              borderRadius: 'var(--radius-xs)',
              overflow: 'hidden',
              background: 'var(--surface-sunken)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {artworkFailed || !currentTrack.artworkUrl ? (
              <Music2 size={ICON.md} style={{ color: 'var(--text-faint)' }} aria-hidden="true" />
            ) : (
              <img
                src={currentTrack.artworkUrl}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onError={() => setArtworkFailed(true)}
              />
            )}
          </span>

          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: '1px' }}>
            <MarqueeText
              text={currentTrack.title}
              style={{
                fontSize: 'var(--text-sm)',
                lineHeight: 'var(--leading-sm)',
                letterSpacing: 'var(--tracking-sm)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)'
              }}
            />
            <span
              className="text-truncate"
              style={{
                fontSize: 'var(--text-xs)',
                lineHeight: 'var(--leading-xs)',
                letterSpacing: 'var(--tracking-xs)',
                color: 'var(--text-muted)'
              }}
            >
              {currentTrack.artist}
            </span>
          </span>
        </button>

        {hasRoom && (
          <button
            type="button"
            className="press focus-ring"
            onClick={() => void prevTrack()}
            aria-label="Предыдущий трек"
            style={ROUND_BUTTON}
            data-testid="mobile-player-prev"
          >
            <SkipBack size={ICON.lg} fill="currentColor" aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          className="press focus-ring"
          onClick={() => void togglePlayPause()}
          aria-label={isPlaying ? 'Пауза' : 'Играть'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '48px',
            height: '48px',
            flexShrink: 0,
            marginRight: 'var(--space-1)',
            borderRadius: 'var(--radius-pill)',
            color: 'var(--text-primary)',
            cursor: 'pointer'
          }}
          data-testid="mobile-player-play-pause"
        >
          {isPlaying ? (
            <Pause size={ICON.xl} fill="currentColor" aria-hidden="true" />
          ) : (
            <Play size={ICON.xl} fill="currentColor" aria-hidden="true" />
          )}
        </button>

        {hasRoom && (
          <>
            <button
              type="button"
              className="press focus-ring"
              onClick={() => void nextTrack()}
              aria-label="Следующий трек"
              style={ROUND_BUTTON}
              data-testid="mobile-player-next"
            >
              <SkipForward size={ICON.lg} fill="currentColor" aria-hidden="true" />
            </button>
            <VolumeSlider
              volume={volume}
              isMuted={isMuted}
              onVolumeChange={setVolume}
              onToggleMute={toggleMute}
              width="88px"
              style={{ flexShrink: 0, marginRight: 'var(--space-2)' }}
            />
          </>
        )}
      </div>

      {/*
        * Есть место — настоящая перемотка, нет — волосяная линия.
        *
        * Двухпиксельная линия сообщает, сколько осталось, но попасть в неё
        * пальцем нельзя, и притворяться перемоткой она не должна.
        */}
      {hasRoom ? (
        <div style={{ padding: '0 var(--space-3) var(--space-2)' }}>
          <SeekBar
            currentTime={currentTime}
            duration={duration}
            buffered={buffered}
            onSeek={seekTo}
            variant="compact"
            idPrefix="mobile-player"
          />
        </div>
      ) : (
      <>
      <div style={{ height: '2px', background: 'var(--bg-lift)' }} aria-hidden="true">
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            background: 'var(--accent)'
          }}
          data-testid="mobile-player-progress"
        />
      </div>
      </>
      )}
    </div>
  );
};

/** Порог, за которым в полосе появляются перемотка, соседние треки и громкость. */
const ROOMY_BAR_WIDTH_PX = 480;

const ROUND_BUTTON: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '40px',
  height: '40px',
  flexShrink: 0,
  borderRadius: 'var(--radius-pill)',
  color: 'var(--text-secondary)',
  cursor: 'pointer'
};
