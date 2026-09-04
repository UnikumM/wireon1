import React from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';

export interface MiniProgressLineProps {
  className?: string;
}

/**
 * Волосяная линия прогресса по верхнему краю компактной полосы плеера.
 *
 * Своим компонентом, а не разметкой внутри полосы, ровно по той же причине, по
 * которой отдельно живёт `PlayerProgress`: `timeupdate` приходит около четырёх
 * раз в секунду, и подписка на время в самой полосе перерисовывала бы её
 * целиком — обложку, бегущую строку, кнопки — ради ширины одной заливки.
 *
 * Это показание, а не орган управления: перемотки здесь нет намеренно. На
 * трёх пикселях высоты попасть пальцем в нужную секунду нельзя, а обещание
 * попасть — есть; настоящий таймлайн ждёт в плеере на весь экран, куда полоса
 * и открывается нажатием.
 */
export const MiniProgressLine: React.FC<MiniProgressLineProps> = ({ className = '' }) => {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);

  // Поток без известной длительности — обычное дело у чанкованного аудио.
  // Рисовать в этом случае нечего: заливка от неизвестного целого соврала бы.
  const ratio = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: '2px',
        // Скругление полосы обрезает углы, и прямая линия торчала бы за контур.
        borderTopLeftRadius: 'inherit',
        borderTopRightRadius: 'inherit',
        overflow: 'hidden',
        pointerEvents: 'none'
      }}
      data-testid="player-mini-progress"
    >
      <div
        style={{
          width: `${ratio * 100}%`,
          height: '100%',
          backgroundColor: 'var(--accent)',
          // Без перехода линия дёргается на каждом тике; с ним она едет ровно
          // настолько, чтобы следующий тик её догнал. Длительность — токеном:
          // ручка «Движение» и просьба системы убрать анимации схлопывают
          // `--dur-normal` в миллисекунду, и линия замирает вместе со всем
          // остальным, а не живёт своей жизнью.
          transition: 'width var(--dur-normal) linear'
        }}
      />
    </div>
  );
};
