/**
 * Matching an imported track to something we can actually play.
 *
 * Playlist import used to take the first search result, which is why well-known
 * songs arrived as sped-up edits, hour-long mixes or karaoke versions: YouTube
 * ranks by popularity, and for a lot of queries the most popular upload is not
 * the song. This module scores candidates instead, so a wrong-but-popular result
 * loses to a right-but-obscure one, and an import can honestly report what it
 * could not find.
 *
 * Shared by the playlist importer, the SoundCloud substitution in
 * `streamResolver.ts` and the lyrics lookup, all of which need the same notion
 * of "is this the same song".
 */

import type { UnifiedTrack } from '../types/music';

/** What we are looking for; every field is optional except the title. */
export interface MatchTarget {
  title: string;
  artist?: string;
  album?: string;
  /** Seconds. When present it is the strongest signal available. */
  duration?: number;
}

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface MatchResult<T> {
  candidate: T;
  score: number;
  confidence: MatchConfidence;
  /** Human-readable reasons, shown in the import report. */
  notes: string[];
  /**
   * Сошлось ли имя исполнителя. `null` — сверять было не с чем: в строке
   * импорта исполнителя нет. Нужно {@link rankCandidates}, чтобы отодвинуть
   * чужих исполнителей, но только когда своего среди кандидатов нашли.
   */
  artistMatched?: boolean | null;
}

/**
 * Decorations that appear in upload titles but never in the song's name.
 * Stripped before comparison so "Song (Official Music Video) [4K]" matches "Song".
 */
const NOISE_PATTERNS: ReadonlyArray<RegExp> = [
  /\((?:official\s*)?(?:music\s*)?video[^)]*\)/gi,
  /\[(?:official\s*)?(?:music\s*)?video[^\]]*\]/gi,
  /\((?:official\s*)?(?:audio|lyrics?|lyric video|visualizer|hd|hq|4k|mv|m\/v)[^)]*\)/gi,
  /\[(?:official\s*)?(?:audio|lyrics?|lyric video|visualizer|hd|hq|4k|mv|m\/v)[^\]]*\]/gi,
  /\b(?:official\s+)?(?:music\s+)?video\b/gi,
  /\bofficial\s+audio\b/gi,
  /\blyrics?\s+video\b/gi,
  /\bfull\s+album\b/gi,
  /\bhd\b|\bhq\b|\b4k\b|\b1080p\b|\b720p\b/gi,
  /\bexplicit\b|\bclean\s+version\b/gi,
  /\bprod\.?\s*by\s+[^)\]]*/gi,
  /\bft\.?\s+/gi,
  /\bfeat\.?\s+/gi,
  /[｜|]/g,
  /【[^】]*】/g,
  /\bnew\s+song\s+\d{4}\b/gi,
  /\b\d{4}\s+release\b/gi
];

/**
 * Variants that are a *different recording* of the same song. Matching one when
 * the user asked for the original is the single most visible import bug, so each
 * carries a penalty and is only forgiven when the target asks for it too.
 */
const VARIANT_MARKERS: ReadonlyArray<{ key: string; pattern: RegExp; penalty: number; label: string }> = [
  { key: 'remix', pattern: /\bremix\b|\brmx\b|\bbootleg\b|\bflip\b|\bvip mix\b/i, penalty: 55, label: 'ремикс' },
  { key: 'live', pattern: /\blive\b|\bконцерт\b|\bat\s+(?:the\s+)?\w+\s+(?:arena|stadium|hall)\b|\bunplugged\b/i, penalty: 50, label: 'живое исполнение' },
  { key: 'cover', pattern: /\bcover\b|\bкавер\b|\btribute\b/i, penalty: 60, label: 'кавер' },
  { key: 'karaoke', pattern: /\bkaraoke\b|\bкараоке\b|\bminus\b|\bминус(?:овка)?\b/i, penalty: 80, label: 'караоке' },
  { key: 'instrumental', pattern: /\binstrumental\b|\bинструментал\b/i, penalty: 70, label: 'инструментал' },
  { key: 'speed', pattern: /\bsped\s*-?\s*up\b|\bspeed\s*up\b|\bnightcore\b|\bускорен/i, penalty: 65, label: 'ускоренная версия' },
  { key: 'slowed', pattern: /\bslowed\b|\breverb\b|\bзамедлен|\bslow(?:ed)?\s*\+\s*reverb\b/i, penalty: 65, label: 'замедленная версия' },
  { key: '8d', pattern: /\b8d\s*(?:audio)?\b|\bbass\s*boost(?:ed)?\b|\b3d\s*audio\b/i, penalty: 60, label: 'обработка' },
  { key: 'mashup', pattern: /\bmashup\b|\bmedley\b|\bmegamix\b|\bmix\s*\d{2,}\b/i, penalty: 55, label: 'сборка' },
  { key: 'acoustic', pattern: /\bacoustic\b|\bакустик/i, penalty: 35, label: 'акустика' },
  { key: 'edit', pattern: /\bradio\s*edit\b|\bshort\s*version\b|\bsnippet\b|\bpreview\b/i, penalty: 30, label: 'сокращённая версия' },
  { key: 'compilation', pattern: /\b(?:top|best)\s*\d+\b|\bplaylist\b|\b\d+\s*hours?\b|\bcompilation\b|\bсборник\b/i, penalty: 90, label: 'сборник' },
  { key: 'reaction', pattern: /\breaction\b|\breview\b|\btutorial\b|\bhow to play\b|\bразбор\b/i, penalty: 95, label: 'не музыка' }
];

/** Tracks longer than this are compilations, not songs, whatever they claim. */
const MAX_PLAUSIBLE_SONG_S = 15 * 60;

/**
 * Folds a string down to comparable letters and digits.
 *
 * Cyrillic is preserved (the library is largely Russian); `ё` collapses onto `е`
 * because catalogues disagree about it, and Latin diacritics are stripped so
 * "Beyoncé" matches "Beyonce".
 */
export function normalizeForMatch(value: string | undefined | null): string {
  if (!value) return '';
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Removes upload decorations, leaving something close to the song's real name. */
export function stripNoise(title: string | undefined | null): string {
  if (!title) return '';
  let out = title;
  for (const pattern of NOISE_PATTERNS) {
    out = out.replace(pattern, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Splits "Artist - Title" style upload titles.
 *
 * YouTube uploads carry the artist in the title and the uploader's channel name
 * is often a label, so the title is the more reliable source of both.
 */
export function splitArtistTitle(raw: string): { artist: string | null; title: string } {
  const cleaned = stripNoise(raw);
  const separators = [' — ', ' – ', ' - ', ' -- ', ' ‒ '];
  for (const sep of separators) {
    const idx = cleaned.indexOf(sep);
    if (idx > 0 && idx < cleaned.length - sep.length) {
      return {
        artist: cleaned.slice(0, idx).trim() || null,
        title: cleaned.slice(idx + sep.length).trim()
      };
    }
  }
  return { artist: null, title: cleaned };
}

function tokens(value: string): string[] {
  const normalized = normalizeForMatch(value);
  return normalized ? normalized.split(' ').filter((t) => t.length > 0) : [];
}

/** Token overlap relative to the shorter side, so "Song" still matches "Song (2019)". */
function overlapRatio(a: string, b: string): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / Math.min(left.size, right.size);
}

/** Ниже этого совпадение имён считается несовпадением. */
export const ARTIST_MATCH_FLOOR = 0.34;

/** Во столько обходится чужой исполнитель. См. пояснение в {@link scoreCandidate}. */
export const ARTIST_MISMATCH_PENALTY = 45;

/**
 * Заглушки вместо имени исполнителя, за которые штрафовать нельзя.
 *
 * В чужих выгрузках сборники подписаны «Various Artists», а часть строк —
 * «Unknown Artist». Совпасть с настоящим исполнителем такие подписи не могут
 * никогда, и штраф за них выбросил бы из импорта весь сборник целиком.
 */
const PLACEHOLDER_ARTISTS = /^(?:various(?:\s+artists)?|va|unknown(?:\s+artist)?|неизвестен|неизвестный исполнитель|разные исполнители)$/i;

function isPlaceholderArtist(value: string): boolean {
  return PLACEHOLDER_ARTISTS.test(value.trim());
}

/** Variant markers present in a string, ignoring ones the target itself asked for. */
export function detectVariants(value: string): string[] {
  const found: string[] = [];
  for (const marker of VARIANT_MARKERS) {
    if (marker.pattern.test(value)) found.push(marker.key);
  }
  return found;
}

/**
 * Scores how well `candidate` answers `target`, from roughly -100 to 130.
 *
 * The weights encode what actually goes wrong in imports: a title that only
 * half-overlaps is usually a different song (heavy), a duration that is off by
 * more than a few seconds is usually a different recording (heavy), and a
 * "sped up" tag is usually fatal even when everything else agrees.
 */
export function scoreCandidate(target: MatchTarget, candidate: UnifiedTrack): MatchResult<UnifiedTrack> {
  const notes: string[] = [];
  let score = 0;

  const targetTitleClean = stripNoise(target.title);
  const candidateSplit = splitArtistTitle(candidate.title || '');
  const candidateTitleClean = candidateSplit.title || stripNoise(candidate.title || '');

  // --- Title -----------------------------------------------------------------
  const titleRatio = Math.max(
    overlapRatio(targetTitleClean, candidateTitleClean),
    // The artist often sits inside the upload title, so compare against the
    // whole thing too rather than punishing "Artist - Title" formatting.
    overlapRatio(targetTitleClean, stripNoise(candidate.title || ''))
  );
  score += titleRatio * 60;
  if (titleRatio < 0.5) notes.push('название совпадает слабо');

  // --- Artist ----------------------------------------------------------------
  let artistMatched: boolean | null = null;
  if (target.artist) {
    const artistRatio = Math.max(
      overlapRatio(target.artist, candidate.artist || ''),
      overlapRatio(target.artist, candidateSplit.artist || ''),
      // Исполнитель часто сидит внутри названия загрузки («Артист — Песня»),
      // а в поле артиста стоит имя канала. Поэтому сверяем и с названием.
      overlapRatio(target.artist, candidate.title || '')
    );
    score += artistRatio * 40;
    // У заглушек вроде «Various Artists» сверять нечего: и вывод «не совпадает»
    // в отчёте об импорте был бы не подсказкой, а шумом на каждой строке.
    if (!isPlaceholderArtist(target.artist)) {
      artistMatched = artistRatio >= ARTIST_MATCH_FLOOR;
      if (!artistMatched) notes.push('исполнитель не совпадает');
    }
  }

  // --- Duration --------------------------------------------------------------
  if (target.duration && candidate.duration) {
    const delta = Math.abs(candidate.duration - target.duration);
    if (delta <= 3) {
      score += 30;
    } else if (delta <= 8) {
      score += 20;
    } else if (delta <= 15) {
      score += 8;
    } else if (delta <= 30) {
      score -= 15;
      notes.push(`длительность отличается на ${Math.round(delta)} с`);
    } else {
      score -= 45;
      notes.push(`длительность отличается на ${Math.round(delta)} с`);
    }
  }

  if (candidate.duration && candidate.duration > MAX_PLAUSIBLE_SONG_S) {
    score -= 60;
    notes.push('слишком длинная запись — вероятно сборник');
  }

  // --- Variants --------------------------------------------------------------
  const targetVariants = new Set(detectVariants(`${target.title} ${target.artist || ''}`));
  const candidateHaystack = `${candidate.title || ''} ${candidate.artist || ''}`;
  for (const marker of VARIANT_MARKERS) {
    if (!marker.pattern.test(candidateHaystack)) continue;
    if (targetVariants.has(marker.key)) {
      // Asked for a remix, found a remix — that is a match, not a mismatch.
      score += 10;
      continue;
    }
    score -= marker.penalty;
    notes.push(marker.label);
  }

  // --- Source quality --------------------------------------------------------
  // YouTube Music surfaces catalogue entries rather than uploads, so its results
  // are far more likely to be the actual song.
  if (candidate.source === 'youtube' && /- topic$/i.test(candidate.artist || '')) {
    score += 12;
    notes.push('официальный канал');
  }
  if (/vevo$/i.test(candidate.artist || '') || /\bofficial\b/i.test(candidate.artist || '')) {
    score += 8;
  }

  const confidence: MatchConfidence = score >= 95 ? 'high' : score >= 60 ? 'medium' : 'low';
  return { candidate, score, confidence, notes, artistMatched };
}

/**
 * Отодвигает чужих исполнителей, но только когда своего нашли.
 *
 * Так выглядела беда при импорте: у песен с одинаковыми названиями побеждала не
 * та запись. Несовпадение исполнителя не стоило ничего — оно лишь не прибавляло
 * очков, — и кандидат с верным названием и посторонним автором набирал 60 за
 * название плюс 30 за длительность, чего хватало с запасом.
 *
 * Почему штраф **относительный**, а не постоянный. Постоянный ломает
 * законное: в чужих выгрузках исполнитель написан латиницей («Kino»), а на
 * YouTube кириллицей («Кино»), общих слов ноль — и правильная запись улетала бы
 * в «не нашли». Поэтому штрафуем, только если среди кандидатов **есть** тот,
 * чей исполнитель сошёлся: значит имя сверить удалось, и остальные — это уже
 * другие записи. Если не сошёлся ни один, поведение прежнее.
 */
function preferMatchingArtist<T>(
  target: MatchTarget,
  scored: MatchResult<T>[]
): MatchResult<T>[] {
  if (!target.artist || isPlaceholderArtist(target.artist)) return scored;
  if (!scored.some((entry) => entry.artistMatched === true)) return scored;
  return scored.map((entry) =>
    entry.artistMatched === false
      ? { ...entry, score: entry.score - ARTIST_MISMATCH_PENALTY }
      : entry
  );
}

/**
 * Picks the best candidate, or null when none is convincing.
 *
 * @param minScore lower bound; below it the importer reports the track as
 *   unmatched instead of guessing, which is the whole point of the rewrite.
 */
export function pickBestMatch(
  target: MatchTarget,
  candidates: ReadonlyArray<UnifiedTrack>,
  minScore = 55
): MatchResult<UnifiedTrack> | null {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const scored = preferMatchingArtist(
    target,
    candidates.map((candidate) => scoreCandidate(target, candidate))
  ).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < minScore) return null;
  return best;
}

/** Every candidate, best first — for the manual "выбрать вручную" picker. */
export function rankCandidates(
  target: MatchTarget,
  candidates: ReadonlyArray<UnifiedTrack>
): MatchResult<UnifiedTrack>[] {
  if (!Array.isArray(candidates)) return [];
  return preferMatchingArtist(
    target,
    candidates.map((candidate) => scoreCandidate(target, candidate))
  ).sort((a, b) => b.score - a.score);
}
