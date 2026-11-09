import React from 'react';

export interface AmbientLightProps {
  /** Цвет обложки — `rgb(...)` из `useDominantColor` или `var(--accent)`. */
  color: string;
  /** Пока играет, пятна медленно дрейфуют; на паузе замирают. */
  playing: boolean;
  /** Насколько плотный верх: сцена на телефоне светлее, чем окно на ПК. */
  intensity?: 'soft' | 'strong';
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
  'data-testid': testId
}) => {
  const wash = (percent: number): string => `color-mix(in srgb, ${color} ${percent}%, transparent)`;
  const [primary, secondary] = intensity === 'strong' ? [46, 28] : [34, 20];
  return (
    <div aria-hidden="true" className="ambient-light" data-testid={testId}>
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
