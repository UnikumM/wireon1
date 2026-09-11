import React from 'react';
import { ICON } from '../../styles/icons';

/**
 * Карточка с обложкой: альбом, плейлист, микс, исполнитель.
 *
 * Одна на всё приложение. Их было две — витринная на главной и карточка
 * подборки в поиске, — и это были две разные вещи на экране: у одной обложка
 * лежала голой, у другой пряталась внутри панели с рамкой и фоном. Одно и то
 * же содержимое в двух видах читается как два разных сорта объекта.
 *
 * Витринное направление держится на том, что главное на экране — сама обложка,
 * поэтому панели вокруг неё нет: карточка — это картинка и две строки под ней.
 * Всё, что отделяло её от фона, делает теперь пустое место между карточками.
 */
export interface CoverCardProps {
  title: string;
  subtitle?: string;
  artworkUrl?: string;
  /** Круглая обложка вместо квадратной: так выглядит человек, а не диск. */
  round?: boolean;
  /** Значок на месте обложки, когда её нет. */
  fallbackIcon?: React.ReactNode;
  testId: string;
  onClick: () => void;
}

export const CoverCard: React.FC<CoverCardProps> = ({
  title,
  subtitle,
  artworkUrl,
  round = false,
  fallbackIcon,
  testId,
  onClick
}) => (
  <button
    type="button"
    className="cover-card focus-ring"
    onClick={onClick}
    data-testid={testId}
    aria-label={subtitle ? `${title} — ${subtitle}` : title}
  >
    <div
      className="cover-card-art"
      style={round ? { borderRadius: 'var(--radius-full)' } : undefined}
      aria-hidden="true"
    >
      {artworkUrl ? (
        <img src={artworkUrl} alt="" loading="lazy" />
      ) : (
        fallbackIcon ?? <span style={{ fontSize: ICON.display }} />
      )}
    </div>

    <div className="cover-card-text">
      <div className="cover-card-title text-truncate">{title}</div>
      {subtitle && <div className="cover-card-subtitle text-truncate">{subtitle}</div>}
    </div>
  </button>
);
