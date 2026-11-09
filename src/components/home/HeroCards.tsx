import React from 'react';
import { Music2, Play, Radio, Smartphone, Monitor, Globe, X } from 'lucide-react';
import { useHandoffStore, remotePosition } from '../../store/useHandoffStore';
import { formatDuration } from '../../utils/time';
import { ICON } from '../../styles/icons';
import type { UnifiedTrack } from '../../types/music';

/**
 * Герой главной — общие карточки для ПК и телефона.
 *
 * Одна разметка на обе оболочки: раскладка вокруг них разная (две колонки на
 * ПК, столбик на телефоне), а сами карточки одни и те же. Это первый общий
 * примитив 4.0 из тех, на которых сходятся настольные и телефонные экраны.
 */

/** Время суток — для подписи Волны. Границы грубые нарочно: это настроение, а не расписание. */
export function dayPart(hour: number): { eyebrow: string; title: string; note: string } {
  if (hour >= 5 && hour < 12) return { eyebrow: 'Волна · утро', title: 'Разогнаться мягко', note: 'Знакомое и светлое, чтобы день начался без рывка.' };
  if (hour >= 12 && hour < 18) return { eyebrow: 'Волна · день', title: 'В ритме дня', note: 'Поток из того, что вы любите, и того, что рядом с ним.' };
  if (hour >= 18 && hour < 23) return { eyebrow: 'Волна · вечер', title: 'Потише, поглубже', note: 'Медленнее, чем днём, с тем, что вы слушали в последние недели.' };
  return { eyebrow: 'Волна · ночь', title: 'Ночная смена', note: 'Тихое и длинное — для часов, когда никто не торопит.' };
}

export function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

export interface WaveCardProps {
  /** Сколько любимых треков — для подписи «опирается на N». */
  favorites: number;
  onStart: () => void;
  'data-testid'?: string;
}

/**
 * Волна — главное действие на главной.
 *
 * Карточка, а не строка в ряду: бесконечный поток — это то, ради чего человек
 * открывает приложение, не зная, что хочет слушать. Подпись меняется со временем
 * суток, чтобы карточка читалась живой, а не вывеской.
 */
export const WaveCard: React.FC<WaveCardProps> = ({ favorites, onStart, 'data-testid': testId = 'home-card-wave' }) => {
  const part = dayPart(new Date().getHours());
  return (
    <button type="button" className="wave-card focus-ring" onClick={onStart} data-testid={testId} aria-label={`Включить Волну: ${part.title}`}>
      <span className="wave-orb" aria-hidden="true" />
      <span className="home-eyebrow">{part.eyebrow}</span>
      <span className="wave-card-title">{part.title}</span>
      <span className="wave-card-note">
        {part.note}
        {favorites > 0 ? ` Опирается на ${favorites} ${plural(favorites, ['любимый трек', 'любимых трека', 'любимых треков'])}.` : ''}
      </span>
      <span className="wave-card-play" aria-hidden="true">
        <Play size={ICON.md} fill="currentColor" />
      </span>
    </button>
  );
};

export interface ResumeCardProps {
  track: UnifiedTrack | null;
  /** Подпись над названием: «Остановились на 1:24», «Сейчас играет», «Начните слушать». */
  kicker: string;
  subtitle: string;
  /** Доля прослушанного 0–100 или `null`, когда полоске нечего показать. */
  progress: number | null;
  playLabel: string;
  onPlay: () => void;
  onRadio: () => void;
  testIds?: { root?: string; art?: string; title?: string; play?: string; radio?: string };
}

/** «Продолжить»: то, на чём остановились, с полосой прослушанного. */
export const ResumeCard: React.FC<ResumeCardProps> = ({ track, kicker, subtitle, progress, playLabel, onPlay, onRadio, testIds = {} }) => {
  const [artFailed, setArtFailed] = React.useState(false);
  React.useEffect(() => setArtFailed(false), [track?.artworkUrl]);
  return (
    <div className="resume-card" data-testid={testIds.root ?? 'home-resume'}>
      <div className="resume-card-art" data-testid={testIds.art ?? 'home-hero-art'}>
        {track?.artworkUrl && !artFailed ? (
          <img src={track.artworkUrl} alt="" onError={() => setArtFailed(true)} className="fill-cover" />
        ) : (
          // Без обложки квадрат был пустым и читался как недогруженный.
          <Music2 size={ICON.xl} aria-hidden="true" className="text-faint" />
        )}
      </div>

      <div className="stack grow gap-1 min-0">
        <div className="home-eyebrow">{kicker}</div>
        <h3 className="m-0 text-truncate type-lg weight-semibold text-primary font-sans" data-testid={testIds.title ?? 'home-hero-title'}>
          {track?.title ?? 'Wireon'}
        </h3>
        <div className="text-truncate type-sm text-secondary">{subtitle}</div>
        {progress !== null && (
          <div className="resume-card-bar" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>

      <div className="row gap-2 shrink-0 resume-card-actions">
        <button
          type="button"
          className="focus-ring press home-btn home-btn-primary"
          onClick={onPlay}
          disabled={!track}
          data-testid={testIds.play ?? 'home-hero-play'}
        >
          <Play size={ICON.sm} fill="currentColor" aria-hidden="true" />
          {playLabel}
        </button>
        <button
          type="button"
          className="focus-ring press home-btn"
          onClick={onRadio}
          disabled={!track}
          aria-label="Радио по треку"
          title="Радио по треку"
          data-testid={testIds.radio ?? 'home-hero-radio'}
        >
          <Radio size={ICON.sm} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

const PLATFORM_LABEL = { mobile: 'телефона', electron: 'компьютера', browser: 'браузера' } as const;
const PLATFORM_ICON = { mobile: Smartphone, electron: Monitor, browser: Globe } as const;

/**
 * «Продолжить здесь» — то, что играет сейчас на другом устройстве человека.
 *
 * Плашка над героем, а не тост: решение не срочное, человек может и не
 * продолжать. Исчезает, когда там остановились, когда продолжили отсюда или
 * когда отмахнулись. Позиция досчитывается по часам, пока там играет.
 */
export const HandoffBanner: React.FC = () => {
  const remote = useHandoffStore((s) => s.remote);
  const takeOver = useHandoffStore((s) => s.takeOver);
  const dismiss = useHandoffStore((s) => s.dismiss);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!remote?.playing) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [remote?.playing, remote?.at]);

  if (!remote) return null;
  const Icon = PLATFORM_ICON[remote.platform];
  const position = remotePosition(remote, now);

  return (
    <div className="handoff-banner row gap-3" role="status" data-testid="handoff-banner">
      <span className="handoff-banner-icon row justify-center shrink-0" aria-hidden="true">
        <Icon size={ICON.md} />
      </span>
      <span className="stack grow min-0 gap-px">
        <span className="type-sm text-secondary">
          {remote.playing ? 'Сейчас играет' : 'На паузе'} с {PLATFORM_LABEL[remote.platform]}
        </span>
        <span className="type-base weight-semibold text-primary text-truncate">
          {remote.track.title}
          <span className="text-muted weight-normal"> — {remote.track.artist} · {formatDuration(position)}</span>
        </span>
      </span>
      <button type="button" className="focus-ring press home-btn home-btn-primary shrink-0" onClick={() => void takeOver()} data-testid="handoff-take-over">
        <Play size={ICON.sm} fill="currentColor" aria-hidden="true" />
        Продолжить здесь
      </button>
      <button type="button" className="focus-ring press handoff-banner-close row justify-center shrink-0" onClick={dismiss} aria-label="Скрыть" data-testid="handoff-dismiss">
        <X size={ICON.sm} aria-hidden="true" />
      </button>
    </div>
  );
};
