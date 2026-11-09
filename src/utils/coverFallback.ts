/**
 * Обложка для трека без обложки.
 *
 * Серый квадрат со значком читался как «не загрузилось». Вместо него — градиент,
 * выведенный из названия и исполнителя: у одного трека он всегда один и тот же на
 * любом устройстве (ничего не хранится), у разных — разный. Насыщенность и
 * светлота сдержанные, чтобы в ряду обложек такая не кричала громче настоящих.
 * Цвета в формате hsl нарочно: у них нет литералов из темы, они из данных.
 */

/** Детерминированный хеш строки → 0…2^32. */
export function coverSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** CSS-градиент для `background`. */
export function coverGradient(title: string, artist?: string): string {
  const seed = coverSeed(`${artist ?? ''}·${title}`);
  const hue = seed % 360;
  const hue2 = (hue + 36 + ((seed >>> 8) % 40)) % 360;
  const angle = 120 + ((seed >>> 16) % 60);
  return `linear-gradient(${angle}deg, hsl(${hue} 42% 28%), hsl(${hue2} 50% 56%))`;
}

/** Первая буква названия — знак на обложке. */
export function coverInitial(title: string): string {
  const letter = title.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '·';
  return letter.toUpperCase();
}
