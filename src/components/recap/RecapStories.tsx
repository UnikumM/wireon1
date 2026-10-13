import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, ListPlus, Music2, Play, X } from 'lucide-react';
import '../../styles/recap.css';
import { useUIStore, refusedForAccount } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { getAllHistory, getPlayEvents } from '../../services/db';
import {
  buildRecap,
  formatBigNumber,
  formatHour,
  genreLabel,
  hasRecap,
  minutesComparison,
  Recap,
  recapRange
} from '../../services/recap';
import { renderRecapCard } from '../../services/recapCard';
import { saveImageFile } from '../../utils/download';
import { pluralize } from '../../utils/plural';
import { ICON } from '../../styles/icons';

/** Сколько живёт один слайд, если его не листать. */
export const RECAP_SLIDE_MS = 7000;

const DAY_PART_LABELS: Array<[keyof Recap['dayParts'], string]> = [
  ['morning', 'Утро'],
  ['day', 'День'],
  ['evening', 'Вечер'],
  ['night', 'Ночь']
];

interface Slide {
  id: string;
  /** Пара цветов фона — вариации акцента, чтобы слайды не сливались. */
  tint: [string, string];
  render: () => React.ReactNode;
}

const TINTS: Array<[string, string]> = [
  ['var(--accent)', 'color-mix(in oklab, var(--accent) 40%, #ff4d8d)'],
  ['color-mix(in oklab, var(--accent) 50%, #ff8a3d)', 'var(--accent)'],
  ['color-mix(in oklab, var(--accent) 45%, #3dd6ff)', 'color-mix(in oklab, var(--accent) 60%, #7c3dff)'],
  ['color-mix(in oklab, var(--accent) 40%, #4dff9a)', 'var(--accent)'],
  ['var(--accent)', 'color-mix(in oklab, var(--accent) 50%, #ffd23d)'],
  ['color-mix(in oklab, var(--accent) 50%, #ff3d6e)', 'color-mix(in oklab, var(--accent) 40%, #3d8bff)'],
  ['var(--accent)', 'color-mix(in oklab, var(--accent) 50%, #ffffff)']
];

const Thumb: React.FC<{ src?: string }> = ({ src }) =>
  src ? (
    <img className="recap-thumb" src={src} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
  ) : (
    <span className="recap-thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Music2 size={ICON.md} aria-hidden="true" />
    </span>
  );

/**
 * «Итоги» — истории на весь экран, как Spotify Wrapped.
 *
 * Монтируется у корня приложения (и на компьютере, и на телефоне) и сам решает,
 * показываться ли: открывает его `useUIStore.openRecap`.
 */
export const RecapStories: React.FC = () => {
  const period = useUIStore((s) => s.recapPeriod);
  const closeRecap = useUIStore((s) => s.closeRecap);
  const showToast = useUIStore((s) => s.showToast);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const createPlaylistWithTracks = useLibraryStore((s) => s.createPlaylistWithTracks);

  const [recap, setRecap] = useState<Recap | null>(null);
  const [playlistTracks, setPlaylistTracks] = useState<Recap['topTracks']>([]);
  const [loading, setLoading] = useState(false);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!period) return;
    let alive = true;
    setLoading(true);
    setIndex(0);
    setRecap(null);
    const now = Date.now();
    const { from } = recapRange(period, now);
    void Promise.all([getPlayEvents(from, 200_000).catch(() => []), getAllHistory().catch(() => [])]).then(
      ([events, history]) => {
        if (!alive) return;
        const full = buildRecap({ events, history, period, now, topLimit: 50 });
        setPlaylistTracks(full.topTracks);
        setRecap({ ...full, topTracks: full.topTracks.slice(0, 5), topArtists: full.topArtists.slice(0, 5) });
        setLoading(false);
      }
    );
    return () => {
      alive = false;
    };
  }, [period]);

  const playTop = useCallback(() => {
    const list = playlistTracks.map((entry) => entry.track);
    if (list.length === 0) return;
    void playTrack(list[0], list, 0);
    closeRecap();
  }, [closeRecap, playTrack, playlistTracks]);

  const savePlaylist = useCallback(async () => {
    if (!recap) return;
    const list = playlistTracks.map((entry) => entry.track);
    const created = await createPlaylistWithTracks(`Итоги · ${recap.label}`, list);
    if (!created) {
      if (!refusedForAccount()) showToast(useLibraryStore.getState().error ?? 'Не удалось сохранить плейлист', 'error');
      return;
    }
    showToast(`Плейлист «${created.title}» — ${pluralize(created.tracks.length, 'трек', 'трека', 'треков')}`, 'success');
  }, [createPlaylistWithTracks, playlistTracks, recap, showToast]);

  const saveCard = useCallback(async () => {
    if (!recap) return;
    const dataUrl = renderRecapCard(recap);
    if (!dataUrl) {
      showToast('Не получилось нарисовать картинку на этом устройстве', 'error');
      return;
    }
    const result = await saveImageFile(`wireon-itogi-${recap.label.replace(/\s+/g, '-').toLowerCase()}.png`, dataUrl);
    if (!result.ok) showToast('Не удалось сохранить картинку', 'error');
    else if (result.where === 'download') showToast('Картинка сохранена в загрузки', 'success');
    else if (result.where === 'documents') showToast('Картинка сохранена', 'success');
  }, [recap, showToast]);

  const slides = useMemo<Slide[]>(() => {
    if (!recap || !hasRecap(recap)) return [];
    const list: Slide[] = [];
    const top = recap.topArtists[0];
    list.push({
      id: 'intro',
      tint: TINTS[0],
      render: () => (
        <>
          <p className="recap-kicker">Wireon · Итоги</p>
          <h2 className="recap-title">{recap.period === 'year' ? `Ваш ${recap.label}` : recap.label}</h2>
          <p className="recap-text">
            {pluralize(recap.totalPlays, 'прослушивание', 'прослушивания', 'прослушиваний')},{' '}
            {pluralize(recap.uniqueTracks, 'трек', 'трека', 'треков')} и{' '}
            {pluralize(recap.uniqueArtists, 'исполнитель', 'исполнителя', 'исполнителей')}. Посмотрим, что
            из этого вышло.
          </p>
        </>
      )
    });
    if (recap.totalMinutes > 0) {
      list.push({
        id: 'minutes',
        tint: TINTS[1],
        render: () => (
          <>
            <p className="recap-kicker">Вы слушали</p>
            <p className="recap-huge" data-testid="recap-minutes">
              {formatBigNumber(recap.totalMinutes)}
            </p>
            <h2 className="recap-title">минут музыки</h2>
            <p className="recap-text">{minutesComparison(recap.totalMinutes)}.</p>
          </>
        )
      });
    }
    if (top) {
      list.push({
        id: 'artist',
        tint: TINTS[2],
        render: () => (
          <>
            <p className="recap-kicker">Ваш главный исполнитель</p>
            {top.artworkUrl && <img className="recap-art" src={top.artworkUrl} alt="" />}
            <h2 className="recap-title" data-testid="recap-top-artist">
              {top.name}
            </h2>
            <p className="recap-text">
              {pluralize(top.plays, 'прослушивание', 'прослушивания', 'прослушиваний')}
              {top.minutes > 0 ? ` · ${pluralize(top.minutes, 'минута', 'минуты', 'минут')}` : ''}
            </p>
          </>
        )
      });
    }
    if (recap.topArtists.length > 1) {
      list.push({
        id: 'artists',
        tint: TINTS[3],
        render: () => (
          <>
            <p className="recap-kicker">Топ исполнителей</p>
            <ol className="recap-list">
              {recap.topArtists.map((artist, i) => (
                <li key={artist.name} style={{ '--i': i } as React.CSSProperties}>
                  <span className="recap-rank">{i + 1}</span>
                  <Thumb src={artist.artworkUrl} />
                  <span style={{ minWidth: 0 }}>
                    <div className="recap-row-title">{artist.name}</div>
                    <div className="recap-row-sub">{pluralize(artist.plays, 'раз', 'раза', 'раз')}</div>
                  </span>
                </li>
              ))}
            </ol>
          </>
        )
      });
    }
    list.push({
      id: 'tracks',
      tint: TINTS[4],
      render: () => (
        <>
          <p className="recap-kicker">Песни, которые вы крутили</p>
          <ol className="recap-list" data-testid="recap-top-tracks">
            {recap.topTracks.map((entry, i) => (
              <li key={entry.track.id} style={{ '--i': i } as React.CSSProperties}>
                <span className="recap-rank">{i + 1}</span>
                <Thumb src={entry.track.artworkUrl} />
                <span style={{ minWidth: 0 }}>
                  <div className="recap-row-title">{entry.track.title}</div>
                  <div className="recap-row-sub">
                    {entry.track.artist} · {pluralize(entry.plays, 'раз', 'раза', 'раз')}
                  </div>
                </span>
              </li>
            ))}
          </ol>
        </>
      )
    });
    const peakHour = recap.peakHour;
    if (peakHour !== null) {
      const max = Math.max(...DAY_PART_LABELS.map(([key]) => recap.dayParts[key]), 0.0001);
      list.push({
        id: 'time',
        tint: TINTS[5],
        render: () => (
          <>
            <p className="recap-kicker">Вы — {recap.persona.title.toLowerCase()}</p>
            <h2 className="recap-title" data-testid="recap-persona">
              {recap.persona.title}
            </h2>
            <p className="recap-text">{recap.persona.description}</p>
            <div className="recap-bars" aria-label="Когда вы слушаете">
              {DAY_PART_LABELS.map(([key, label]) => (
                <div className="recap-bar" key={key}>
                  <span>{Math.round(recap.dayParts[key] * 100)}%</span>
                  <span className="recap-bar-fill" style={{ height: `${(recap.dayParts[key] / max) * 100}%` }} />
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <p className="recap-text">
              Чаще всего музыка играет около {formatHour(peakHour)}
              {recap.longestStreak > 1 ? `, а самая длинная серия — ${pluralize(recap.longestStreak, 'день', 'дня', 'дней')} подряд` : ''}
              {recap.topGenres[0] ? `. Ваш звук — ${genreLabel(recap.topGenres[0])}` : ''}.
            </p>
          </>
        )
      });
    }
    list.push({
      id: 'summary',
      tint: TINTS[6],
      render: () => (
        <>
          <p className="recap-kicker">{recap.label} в одной картинке</p>
          <h2 className="recap-title">
            {formatBigNumber(recap.totalMinutes)} мин · {recap.persona.title}
          </h2>
          <p className="recap-text">
            Топ-исполнитель — {top?.name ?? '—'}, любимая песня — «{recap.topTracks[0]?.track.title ?? '—'}».
          </p>
          <div className="recap-actions">
            <button type="button" className="recap-btn recap-btn--primary" onClick={playTop} data-testid="recap-play-top">
              <Play size={ICON.md} aria-hidden="true" /> Слушать топ
            </button>
            <button type="button" className="recap-btn" onClick={() => void savePlaylist()} data-testid="recap-save-playlist">
              <ListPlus size={ICON.md} aria-hidden="true" /> В плейлист
            </button>
            <button type="button" className="recap-btn" onClick={() => void saveCard()} data-testid="recap-save-card">
              <Download size={ICON.md} aria-hidden="true" /> Картинка
            </button>
          </div>
        </>
      )
    });
    return list;
  }, [playTop, recap, saveCard, savePlaylist]);

  const next = useCallback(() => {
    setIndex((i) => {
      if (i + 1 >= slides.length) return i;
      return i + 1;
    });
  }, [slides.length]);
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!period) return;
    /*
     * В фазе захвата и с остановкой: иначе те же клавиши ловили бы общие
     * сочетания плеера — пробел ставил бы музыку на паузу, а стрелки
     * перематывали трек вместе с перелистыванием слайда.
     */
    const onKey = (event: KeyboardEvent) => {
      let handled = true;
      if (event.key === 'Escape') closeRecap();
      else if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') prev();
      else if (event.key === ' ') setPaused((p) => !p);
      else handled = false;
      if (handled) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [closeRecap, next, period, prev]);

  // Автолистание: таймер, а не конец CSS-анимации — у части WebView события
  // анимаций не приходят, и истории вставали бы на первом слайде.
  useEffect(() => {
    if (!period || paused || slides.length === 0 || index >= slides.length - 1) return;
    const timer = setTimeout(next, RECAP_SLIDE_MS);
    return () => clearTimeout(timer);
  }, [index, next, paused, period, slides.length]);

  if (!period || typeof document === 'undefined') return null;

  const slide = slides[index];
  const empty = !loading && slides.length === 0;

  return createPortal(
    <div className="recap-overlay" role="dialog" aria-modal="true" aria-label="Итоги" data-testid="recap-stories">
      <div
        className="recap-stage"
        style={slide ? ({ '--recap-a': slide.tint[0], '--recap-b': slide.tint[1] } as React.CSSProperties) : undefined}
        onPointerDown={() => setPaused(true)}
        onPointerUp={() => setPaused(false)}
        onPointerLeave={() => setPaused(false)}
      >
        <div className="recap-bg" aria-hidden="true" />
        {slides.length > 0 && (
          <div className="recap-progress" aria-hidden="true">
            {slides.map((s, i) => (
              <div className="recap-progress-track" key={s.id}>
                <div
                  className="recap-progress-fill"
                  style={
                    i < index
                      ? { transform: 'none' }
                      : i === index
                        ? {
                            animation: `recap-progress ${RECAP_SLIDE_MS}ms linear both`,
                            animationPlayState: paused ? 'paused' : 'running'
                          }
                        : { transform: 'scaleX(0)' }
                  }
                />
              </div>
            ))}
          </div>
        )}
        <button type="button" className="recap-close" onClick={closeRecap} aria-label="Закрыть итоги" data-testid="recap-close">
          <X size={ICON.lg} />
        </button>
        {slides.length > 1 && (
          <>
            <button type="button" className="recap-tap recap-tap--prev" onClick={prev} aria-label="Назад" data-testid="recap-prev" />
            <button type="button" className="recap-tap recap-tap--next" onClick={next} aria-label="Дальше" data-testid="recap-next" />
          </>
        )}
        {loading && (
          <div className="recap-slide">
            <p className="recap-kicker">Считаем итоги…</p>
          </div>
        )}
        {empty && (
          <div className="recap-slide" data-testid="recap-empty">
            <p className="recap-kicker">Итоги</p>
            <h2 className="recap-title">Пока маловато музыки</h2>
            <p className="recap-text">
              {period === 'month'
                ? 'В этом месяце прослушиваний ещё почти нет. Послушайте что-нибудь — итоги соберутся сами.'
                : 'В этом году прослушиваний ещё почти нет. Послушайте что-нибудь — итоги соберутся сами.'}
            </p>
          </div>
        )}
        {slide && (
          <div className="recap-slide" key={slide.id} data-testid={`recap-slide-${slide.id}`}>
            {slide.render()}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
