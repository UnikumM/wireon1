import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Music2 } from 'lucide-react';
import { island } from '../../../styles/motion';
import { ICON } from '../../../styles/icons';
import type { UnifiedTrack } from '../../../types/music';

/**
 * Один `layoutId` на все тела плеера. Обложка в плашке, обложка на сцене и
 * обложка в полосе — один и тот же предмет: когда одно тело сменяет другое,
 * motion ведёт его из прежних границ в новые, а не рисует заново.
 */
export const ARTWORK_LAYOUT_ID = 'now-playing-artwork';

export interface NowPlayingArtworkProps {
  track: UnifiedTrack | null;
  className?: string;
  /** Только значения из данных: радиус из настройки, размер из метрик плотности. */
  style?: React.CSSProperties;
  /**
   * Участвует ли в морфе между телами плеера. Выключается там, где обложек на
   * экране несколько (очередь, список) — иначе motion будет гонять её между ними.
   */
  morph?: boolean;
  /** Размер значка-заглушки, когда обложки нет. */
  fallbackIcon?: number;
  alt?: string;
  'data-testid'?: string;
  children?: React.ReactNode;
}

/**
 * Обложка играющего трека с заглушкой и памятью об ошибке загрузки.
 *
 * Ошибка привязана к адресу: сломанная картинка прошлого трека не должна
 * прятать обложку следующего — это и был баг «после одной битой обложки все
 * дальнейшие серые».
 */
export const NowPlayingArtwork: React.FC<NowPlayingArtworkProps> = ({
  track,
  className = '',
  style,
  morph = true,
  fallbackIcon = ICON.lg,
  alt = '',
  'data-testid': testId,
  children
}) => {
  const url = track?.artworkUrl || null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => setFailedUrl(null), [url]);

  const showImage = Boolean(url) && failedUrl !== url;
  const content = (
    <>
      {showImage ? (
        <img src={url as string} alt={alt} className="fill-cover block" onError={() => setFailedUrl(url)} />
      ) : (
        <Music2 size={fallbackIcon} className="text-faint" aria-hidden="true" />
      )}
      {children}
    </>
  );

  const classes = `now-playing-artwork ${className}`;
  if (!morph) {
    return (
      <div className={classes} style={style} data-testid={testId}>
        {content}
      </div>
    );
  }
  return (
    <motion.div
      layoutId={ARTWORK_LAYOUT_ID}
      layout
      // Без кроссфейда: обложка в двух телах — одна и та же картинка, и ей
      // нечего проявлять. С кроссфейдом летящая копия гасла на полпути.
      layoutCrossfade={false}
      transition={island()}
      className={classes}
      style={style}
      data-testid={testId}
    >
      {content}
    </motion.div>
  );
};
