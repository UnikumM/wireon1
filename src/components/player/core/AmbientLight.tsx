import React from 'react';

export interface AmbientLightProps {
  /** Цвет обложки — `rgb(...)` из `useDominantColor` или `var(--accent)`. */
  color: string;
  /** Пока играет, пятна медленно дрейфуют; на паузе замирают. */
  playing: boolean;
  /** Насколько плотный верх: сцена на телефоне светлее, чем окно на ПК. */
  intensity?: 'soft' | 'strong';
  /**
   * Обложка под светом — размытая, едва различимая. Даёт фону фактуру трека, а
   * не ровную заливку; пятна света ложатся поверх неё.
   */
  artworkUrl?: string | null;
  /** Громкость момента 0…1 (useAudioEnergy): пульс вокруг центра дышит в такт. */
  energy?: number;
  'data-testid'?: string;
}

/**
 * Свет от обложки. Два пятна цвета трека, которые дрейфуют друг против друга,
 * и затемнение, которое держит контраст текста при любой яркости обложки.
 *
 * `color-mix` нужен потому, что цвет приходит и как `rgb(...)`, и как
 * `var(--accent)`: второе в rgba() руками не превратить.
 */
export const AmbientLight: React.FC<AmbientLightProps> = ({
  color,
  playing,
  intensity = 'soft',
  artworkUrl = null,
  energy = 0,
  'data-testid': testId
}) => {
  const wash = (percent: number): string => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
  const [primary, secondary] = intensity === 'strong' ? [46, 28] : [34, 20];
  return (
    <div aria-hidden="true" className="ambient-light" data-testid={testId}>
      {artworkUrl && <img className="ambient-light-art" src={artworkUrl} alt="" draggable={false} />}
      <div
        className="ambient-light-pulse"
        style={{ opacity: Math.min(0.55, energy * 0.7), backgroundImage: `radial-gradient(closest-side, ${wash(60)} 0%, transparent 100%)` }}
        data-testid={testId ? `${testId}-pulse` : undefined}
      />
      <div
        className={`ambient-light-wash ambient-light-wash-a ${playing ? 'ambient-wash-a' : ''}`}
        style={{ backgroundImage: `radial-gradient(closest-side, ${wash(primary)} 0%, transparent 100%)` }}
        data-playing={playing ? 'true' : 'false'}
      />
      <div
        className={`ambient-light-wash ambient-light-wash-b ${playing ? 'ambient-wash-b' : ''}`}
        style={{ backgroundImage: `radial-gradient(closest-side, ${wash(secondary)} 0%, transparent 100%)` }}
        data-playing={playing ? 'true' : 'false'}
      />
      <div className="ambient-light-scrim" />
    </div>
  );
};
