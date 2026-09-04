/**
 * Russian noun agreement, for counts shown in the UI.
 *
 * Three forms are required, and the rule is not "singular vs plural": 1 трек,
 * 2 трека, 5 треков, and then 11-14 take the last form even though they end in
 * 1-4 (11 треков, not «11 трек»).
 */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** `pluralize(3, 'трек', 'трека', 'треков')` → `'3 трека'`. */
export function pluralize(count: number, one: string, few: string, many: string): string {
  return `${count} ${plural(count, one, few, many)}`;
}
