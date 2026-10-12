/**
 * Картинка «Итогов» для сторис и мессенджеров: 1080×1920, как у Spotify.
 *
 * Рисуется только текстом и градиентами. Обложки с YouTube и SoundCloud
 * приходят без заголовков CORS, и одна такая картинка на холсте делает его
 * «запятнанным» — `toDataURL` тогда бросает исключение, и сохранить нечего.
 */

import { Recap, formatBigNumber, formatHour, genreLabel } from './recap';

export const RECAP_CARD_WIDTH = 1080;
export const RECAP_CARD_HEIGHT = 1920;

/** Цвет акцента из темы; без документа — фирменный по умолчанию. */
export function readAccentColor(): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return '#7c5cff';
  const value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return value || '#7c5cff';
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (!text) return '';
  if (typeof ctx.measureText !== 'function' || ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Рисует карточку на переданном холсте. Возвращает data URL или `null`, если
 * холст недоступен (тесты, старый WebView без 2D-контекста).
 */
export function renderRecapCard(recap: Recap, accent: string = readAccentColor(), canvas?: HTMLCanvasElement): string | null {
  if (typeof document === 'undefined' && !canvas) return null;
  const el = canvas ?? document.createElement('canvas');
  el.width = RECAP_CARD_WIDTH;
  el.height = RECAP_CARD_HEIGHT;
  const ctx = el.getContext('2d');
  if (!ctx) return null;

  const W = RECAP_CARD_WIDTH;
  const H = RECAP_CARD_HEIGHT;
  const font = (weight: number, size: number) =>
    `${weight} ${size}px "Unbounded Variable", "Onest Variable", "Inter Tight Variable", system-ui, sans-serif`;

  // Фон: глубокий тёмный с пятном акцента сверху и снизу.
  ctx.fillStyle = '#0b0b10';
  ctx.fillRect(0, 0, W, H);
  const glowTop = ctx.createRadialGradient(W * 0.2, H * 0.1, 0, W * 0.2, H * 0.1, W * 1.1);
  glowTop.addColorStop(0, accent);
  glowTop.addColorStop(1, 'rgba(11,11,16,0)');
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = glowTop;
  ctx.fillRect(0, 0, W, H);
  const glowBottom = ctx.createRadialGradient(W * 0.9, H * 0.95, 0, W * 0.9, H * 0.95, W * 0.9);
  glowBottom.addColorStop(0, accent);
  glowBottom.addColorStop(1, 'rgba(11,11,16,0)');
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = glowBottom;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;

  const left = 96;
  const maxText = W - left * 2;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = font(500, 40);
  ctx.fillText('WIREON · ИТОГИ', left, 180);
  ctx.fillStyle = '#ffffff';
  ctx.font = font(800, 120);
  ctx.fillText(truncate(ctx, recap.label, maxText), left, 320);

  // Минуты — главная цифра.
  ctx.font = font(800, 200);
  ctx.fillText(formatBigNumber(recap.totalMinutes), left, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = font(500, 48);
  ctx.fillText('минут музыки', left, 680);

  // Топ исполнителей и треков.
  let y = 820;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = font(600, 36);
  ctx.fillText('ТОП ИСПОЛНИТЕЛЕЙ', left, y);
  y += 70;
  recap.topArtists.slice(0, 5).forEach((artist, i) => {
    ctx.fillStyle = accent;
    ctx.font = font(800, 52);
    ctx.fillText(String(i + 1), left, y);
    ctx.fillStyle = '#ffffff';
    ctx.font = font(600, 52);
    ctx.fillText(truncate(ctx, artist.name, maxText - 80), left + 80, y);
    y += 74;
  });

  y += 40;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = font(600, 36);
  ctx.fillText('ТОП ТРЕКОВ', left, y);
  y += 70;
  recap.topTracks.slice(0, 5).forEach((entry, i) => {
    ctx.fillStyle = accent;
    ctx.font = font(800, 44);
    ctx.fillText(String(i + 1), left, y);
    ctx.fillStyle = '#ffffff';
    ctx.font = font(600, 44);
    ctx.fillText(truncate(ctx, entry.track.title, maxText - 80), left + 80, y);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = font(400, 32);
    ctx.fillText(truncate(ctx, entry.track.artist, maxText - 80), left + 80, y + 42);
    y += 100;
  });

  // Нижняя плашка: тип слушателя, жанр, пиковый час.
  const facts = [
    recap.persona.title,
    recap.topGenres[0] ? genreLabel(recap.topGenres[0]) : null,
    recap.peakHour !== null ? `пик в ${formatHour(recap.peakHour)}` : null
  ].filter(Boolean) as string[];
  ctx.fillStyle = '#ffffff';
  ctx.font = font(700, 46);
  ctx.fillText(truncate(ctx, facts.join(' · '), maxText), left, H - 150);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = font(500, 32);
  ctx.fillText('wireon sounds', left, H - 90);

  try {
    return el.toDataURL('image/png');
  } catch {
    return null;
  }
}
