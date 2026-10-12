import { describe, it, expect, beforeEach } from 'vitest';
import '../setup';
import {
  collectTrackFacts,
  evaluateSmartPlaylist,
  matchesRule,
  describeRules,
  defaultRule,
  sanitizeSmartPlaylists,
  SmartPlaylist,
  SmartTrackFacts,
  SMART_FIELD_OPS,
  SMART_PRESETS
} from '../../src/services/smartPlaylists';
import { useSmartPlaylistStore, SMART_PLAYLISTS_KEY } from '../../src/store/useSmartPlaylistStore';
import * as dbService from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';

const DAY = 86400000;
const NOW = new Date(2026, 9, 14, 12).getTime();

const t = (id: string, artist: string, extra: Partial<UnifiedTrack> = {}): UnifiedTrack => ({
  id,
  source: 'youtube',
  originalId: id,
  title: `Song ${id}`,
  artist,
  duration: 200,
  artworkUrl: '',
  ...extra
});

const facts = (track: UnifiedTrack, patch: Partial<SmartTrackFacts> = {}): SmartTrackFacts => ({
  track,
  plays: 0,
  skips: 0,
  lastPlayed: null,
  added: null,
  favorite: false,
  ...patch
});

const playlist = (patch: Partial<SmartPlaylist>): SmartPlaylist => ({
  id: 'smart_test',
  title: 'T',
  match: 'all',
  rules: [],
  sort: 'title',
  limit: 0,
  createdAt: 1,
  updatedAt: 1,
  ...patch
});

describe('умные плейлисты: правила', () => {
  it('строки без учёта регистра и ё, пустое правило не мешает', () => {
    const f = facts(t('a', 'Ёлка'));
    expect(matchesRule(f, { field: 'artist', op: 'contains', value: 'елк' }, NOW)).toBe(true);
    expect(matchesRule(f, { field: 'artist', op: 'not_contains', value: 'елк' }, NOW)).toBe(false);
    expect(matchesRule(f, { field: 'artist', op: 'is', value: 'ЁЛКА' }, NOW)).toBe(true);
    expect(matchesRule(f, { field: 'title', op: 'contains', value: '  ' }, NOW)).toBe(true);
  });

  it('давность: «не было N дней» включает никогда не игравшие', () => {
    const never = facts(t('a', 'x'));
    const recent = facts(t('b', 'x'), { lastPlayed: NOW - 2 * DAY, plays: 1 });
    const old = facts(t('c', 'x'), { lastPlayed: NOW - 40 * DAY, plays: 1 });
    const rule = { field: 'lastPlayed' as const, op: 'not_within_days' as const, value: 30 };
    expect([never, recent, old].map((f) => matchesRule(f, rule, NOW))).toEqual([true, false, true]);
    expect(matchesRule(never, { field: 'lastPlayed', op: 'never', value: 0 }, NOW)).toBe(true);
    expect(matchesRule(recent, { field: 'lastPlayed', op: 'within_days', value: 7 }, NOW)).toBe(true);
  });

  it('длительность в минутах, неизвестная не проходит', () => {
    expect(matchesRule(facts(t('a', 'x', { duration: 150 })), { field: 'duration', op: 'lte', value: 3 }, NOW)).toBe(true);
    expect(matchesRule(facts(t('a', 'x', { duration: 0 })), { field: 'duration', op: 'lte', value: 3 }, NOW)).toBe(false);
  });

  it('у каждого поля правило по умолчанию допустимо', () => {
    for (const field of Object.keys(SMART_FIELD_OPS) as Array<keyof typeof SMART_FIELD_OPS>) {
      expect(SMART_FIELD_OPS[field]).toContain(defaultRule(field).op);
    }
  });
});

describe('умные плейлисты: сбор и выборка', () => {
  const favorites = [t('a', 'Кино', { addedAt: NOW - 100 * DAY }), t('b', 'Кино', { addedAt: NOW - DAY })];
  const playlistTracks = [t('c', 'Земфира', { addedAt: NOW - 5 * DAY, source: 'soundcloud' }), t('a', 'Кино', { addedAt: NOW - 200 * DAY })];
  const history: dbService.HistoryRecord[] = [
    { id: 'a', track: favorites[0], playCount: 10, playedAt: NOW - 60 * DAY },
    { id: 'c', track: playlistTracks[0], playCount: 2, playedAt: NOW - DAY, skipCount: 3 },
    { id: 'd', track: t('d', 'Сплин'), playCount: 7, playedAt: NOW - 3 * DAY }
  ];
  const all = collectTrackFacts({ favorites, playlistTracks, history });

  it('собирает факты без повторов', () => {
    expect(all.map((f) => f.track.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    const a = all.find((f) => f.track.id === 'a')!;
    expect(a.favorite).toBe(true);
    expect(a.plays).toBe(10);
    expect(a.added).toBe(NOW - 200 * DAY);
    expect(all.find((f) => f.track.id === 'b')!.lastPlayed).toBeNull();
  });

  it('«любимое, но забытое»', () => {
    const preset = SMART_PRESETS[0];
    const ids = evaluateSmartPlaylist(playlist({ ...preset, sort: 'title' }), all, NOW).map((x) => x.id);
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('«любое из» и сортировка с ограничением', () => {
    const p = playlist({
      match: 'any',
      rules: [
        { field: 'source', op: 'is', value: 'soundcloud' },
        { field: 'plays', op: 'gte', value: 7 }
      ],
      sort: 'plays',
      limit: 2
    });
    expect(evaluateSmartPlaylist(p, all, NOW).map((x) => x.id)).toEqual(['a', 'd']);
  });

  it('«вперемешку» стабильно в течение суток', () => {
    const p = playlist({ sort: 'random' });
    const first = evaluateSmartPlaylist(p, all, NOW).map((x) => x.id);
    expect(evaluateSmartPlaylist(p, all, NOW + 1000).map((x) => x.id)).toEqual(first);
  });

  it('описание правил читается', () => {
    expect(describeRules(SMART_PRESETS[0])).toBe('в избранном · не слушали 30 дн.');
    expect(describeRules({ match: 'all', rules: [] })).toBe('Все треки медиатеки');
  });

  it('мусор из настроек отбрасывается', () => {
    const clean = sanitizeSmartPlaylists([
      null,
      { id: 'x', title: '', match: 'weird', rules: [{ field: 'nope', op: 'is', value: 1 }, { field: 'plays', op: 'gte', value: 2 }], sort: 'bad', limit: -5 }
    ]);
    expect(clean).toHaveLength(1);
    expect(clean[0]).toMatchObject({ title: 'Умный плейлист', match: 'all', sort: 'plays', limit: 0 });
    expect(clean[0].rules).toHaveLength(1);
  });
});

describe('умные плейлисты: стор', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    useSmartPlaylistStore.setState({ playlists: [], hydrated: false });
  });

  it('создаёт, правит, удаляет и переживает перезапуск', async () => {
    const store = useSmartPlaylistStore.getState();
    const created = store.create({ ...SMART_PRESETS[1] });
    useSmartPlaylistStore.getState().update(created.id, { title: 'Мой топ' });
    await new Promise((r) => setTimeout(r, 20));
    const saved = await dbService.getSetting<SmartPlaylist[]>(SMART_PLAYLISTS_KEY, []);
    expect(saved[0].title).toBe('Мой топ');

    useSmartPlaylistStore.setState({ playlists: [], hydrated: false });
    await useSmartPlaylistStore.getState().hydrate();
    expect(useSmartPlaylistStore.getState().playlists[0].title).toBe('Мой топ');

    useSmartPlaylistStore.getState().remove(created.id);
    expect(useSmartPlaylistStore.getState().playlists).toHaveLength(0);
  });
});
