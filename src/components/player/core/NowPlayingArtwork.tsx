import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Music2 } from 'lucide-react';
import { island } from '../../../styles/motion';
import { ICON } from '../../../styles/icons';
import type { UnifiedTrack } from '../../../types/music';
import { coverGradient, coverInitial } from '../../../utils/coverFallback';
import { useOfflineArtwork } from '../../../hooks/useOfflineArtwork';
import {
  artworkCandidates,
  currentNetworkHints,
  isMissingFramePlaceholder,
  pickArtworkSize
} from '../../../utils/artworkUrl';

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
  /**
   * Сколько пикселей обложка занимает на экране, если она крупная (сцена,
   * полноэкранный плеер). Тогда поверх картинки из медиатеки подгружается та же
   * обложка в нужном размере. Без этого пропа — только картинка из медиатеки:
   * полосе и строкам очереди крупнее не нужно.
   */
  displayPx?: number;
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
  displayPx,
  alt = '',
  'data-testid': testId,
  children
}) => {
  // Сохранённая обложка важнее сетевой: она в лучшем качестве и есть без
  // интернета. В списках (очередь) её не спрашиваем — там десятки строк.
  const offlineUrl = useOfflineArtwork(track?.id, morph || Boolean(displayPx));
  const url = offlineUrl || track?.artworkUrl || null;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => setFailedUrl(null), [url]);

  /*
   * Чёткая копия для крупной обложки.
   *
   * Кандидаты идут от лучшего к худшему: крупные кадры YouTube есть не у
   * каждого видео, и вместо отсутствующего приходит серая заглушка 120×90 —
   * картинка, а не ошибка, поэтому после загрузки проверяется её размер.
   * Чёткая копия лежит поверх мелкой и проявляется, когда загрузилась: мелкая
   * уже в кэше и видна сразу, так что перелёт обложки из полосы на сцену не
   * моргает пустым квадратом.
   */
  const sharpCandidates = useMemo(() => {
    if (!url || !displayPx) return [];
    return artworkCandidates(url, pickArtworkSize(displayPx, currentNetworkHints())).filter((candidate) => candidate !== url);
  }, [url, displayPx]);
  const [sharpIndex, setSharpIndex] = useState(0);
  const [sharpReady, setSharpReady] = useState(false);
  useEffect(() => {
    setSharpIndex(0);
    setSharpReady(false);
  }, [sharpCandidates]);
  const sharpUrl = sharpCandidates[sharpIndex] ?? null;
  const nextSharp = () => {
    setSharpReady(false);
    setSharpIndex((index) => index + 1);
  };

  const showImage = Boolean(url) && failedUrl !== url;
  const content = (
    <>
      {showImage ? (
        <>
          <img src={url as string} alt={alt} className="fill-cover block" onError={() => setFailedUrl(url)} />
          {sharpUrl && (
            <img
              key={sharpUrl}
              src={sharpUrl}
              alt=""
              aria-hidden="true"
              className="fill-cover block artwork-sharp"
              data-ready={sharpReady ? 'true' : 'false'}
              data-testid="artwork-sharp"
              onLoad={(event) => {
                const image = event.currentTarget;
                if (isMissingFramePlaceholder(image.naturalWidth, image.naturalHeight)) nextSharp();
                else setSharpReady(true);
              }}
              onError={nextSharp}
            />
          )}
        </>
      ) : track ? (
        // Трек без обложки: градиент из названия и буква вместо серого квадрата
        // со значком (utils/coverFallback). Значение из данных — потому инлайном.
        <span className="cover-fallback fill-cover row justify-center" style={{ background: coverGradient(track.title, track.artist) }} aria-hidden="true">
          <span className="cover-fallback-letter">{coverInitial(track.title)}</span>
        </span>
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
