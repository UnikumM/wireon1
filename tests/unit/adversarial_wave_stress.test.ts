import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  RecommendationEngineService,
  normalizeArtist,
  dedupeKey,
  isRadioFriendly,
  WaveConfig,
  ScoredCandidate
} from '../../src/services/recommendationEngine';
import {
  clearAllData,
  addDislike,
  getDislikedTrackIds
} from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';
import { YouTubeService } from '../../src/services/youtube';
import { SoundCloudService } from '../../src/services/soundcloud';
import { usePlayerStore } from '../../src/store/usePlayerStore';

describe('Adversarial Empirical Stress Testing — Поток & Track Radio', () => {
  let mockYtService: YouTubeService;
  let mockScService: SoundCloudService;
  let engine: RecommendationEngineService;

  const createTrack = (
    id: string,
    source: 'youtube' | 'soundcloud',
    title: string,
    artist: string,
    duration: number = 200
  ): UnifiedTrack => ({
    id,
    source,
    originalId: `orig_${id}`,
    title,
    artist,
    duration,
    artworkUrl: `https://example.com/${id}.jpg`
  });

  beforeEach(async () => {
    await clearAllData();

    // Reset player store
    usePlayerStore.setState({
      currentTrack: null,
      playbackState: 'idle',
      isPlaying: false,
      isLoading: false,
      userQueue: [],
      sourceQueue: [],
      history: [],
      currentIndex: -1,
      shuffleOrder: [],
      queueMode: 'sequential',
      activeWaveMood: 'favorite',
      activeWaveGenre: null,
      activeSeedTrack: null,
      isReplenishingQueue: false,
      autoplayRadio: false
    });

    mockYtService = {
      search: vi.fn().mockResolvedValue([
        createTrack('yt_1', 'youtube', 'Cyberpunk Action', 'Glitch Mob', 220),
        createTrack('yt_2', 'youtube', 'Synthwave Night', 'Kavinsky', 240),
        createTrack('yt_3', 'youtube', 'Dark Techno', 'Carpenter Brut', 200)
      ]),
      getRelatedVideos: vi.fn().mockResolvedValue([
        createTrack('yt_rel_1', 'youtube', 'Related Wave 1', 'Glitch Mob', 210),
        createTrack('yt_rel_2', 'youtube', 'Related Wave 2', 'Kavinsky', 230)
      ]),
      getSuggestions: vi.fn().mockResolvedValue([]),
      resolveStreamUrl: vi.fn().mockResolvedValue({
        streamUrl: 'https://stream.youtube.test/audio',
        format: 'm4a',
        bitrate: 160,
        expiresAt: Date.now() + 3600000
      })
    } as unknown as YouTubeService;

    mockScService = {
      search: vi.fn().mockResolvedValue([
        createTrack('sc_1', 'soundcloud', 'Lofi Sunset', 'Chillhop Music', 180),
        createTrack('sc_2', 'soundcloud', 'Ambient Dreams', 'Tycho', 250),
        createTrack('sc_3', 'soundcloud', 'Deep Focus Flow', 'Bonobo', 300)
      ]),
      getRelatedTracks: vi.fn().mockResolvedValue([
        createTrack('sc_rel_1', 'soundcloud', 'Related SC 1', 'Tycho', 220),
        createTrack('sc_rel_2', 'soundcloud', 'Related SC 2', 'Bonobo', 260)
      ]),
      getClientId: vi.fn().mockResolvedValue('mock_sc_client_id'),
      resolveStreamUrl: vi.fn().mockResolvedValue({
        streamUrl: 'https://stream.soundcloud.test/audio',
        format: 'mp3',
        bitrate: 128,
        expiresAt: Date.now() + 3600000
      })
    } as unknown as SoundCloudService;

    engine = new RecommendationEngineService(mockYtService, mockScService);
  });

  afterEach(async () => {
    await clearAllData();
  });

  // =========================================================================
  // 1. Extreme Cold-Start & Offline / Failure Resilience
  // =========================================================================
  describe('Dimension 1: Extreme Cold-Start & Total Database Emptiness', () => {
    it('builds a clean UserProfile when DB is completely empty (0 history, 0 favs, 0 dislikes)', async () => {
      const profile = await engine.buildUserProfile();

      expect(profile).toBeDefined();
      expect(profile.totalPlays).toBe(0);
      expect(profile.topArtists).toEqual([]);
      expect(profile.artistAffinities.size).toBe(0);
      expect(profile.favoriteTrackIds.size).toBe(0);
      expect(profile.dislikedTrackIds.size).toBe(0);
      expect(profile.recentTrackIds.size).toBe(0);
    });

    it('generates recommendations for all 5 moods in total cold start without crashing', async () => {
      const moods: Array<WaveConfig['mood']> = ['favorite', 'discovery', 'energy', 'chill', 'focus'];

      for (const mood of moods) {
        const recs = await engine.getRecommendationsForWave({ mood }, 6);
        expect(recs).toBeDefined();
        expect(Array.isArray(recs)).toBe(true);
        expect(recs.length).toBeGreaterThan(0);
        expect(recs.length).toBeLessThanOrEqual(6);

        // Every recommended track must have valid id, title, artist
        for (const track of recs) {
          expect(track.id).toBeTruthy();
          expect(track.title).toBeTruthy();
          expect(track.artist).toBeTruthy();
        }
      }
    });

    it('handles total upstream network/search service failure gracefully (empty results, no crash)', async () => {
      // Mock upstream APIs throwing errors or returning empty lists
      (mockYtService.search as any).mockRejectedValue(new Error('Network offline'));
      (mockScService.search as any).mockRejectedValue(new Error('SoundCloud 503 Service Unavailable'));
      (mockYtService.getRelatedVideos as any).mockRejectedValue(new Error('YT Related 500'));
      (mockScService.getRelatedTracks as any).mockRejectedValue(new Error('SC Related 500'));

      const recs = await engine.getRecommendationsForWave({ mood: 'discovery' }, 10);
      expect(recs).toEqual([]);

      const radio = await engine.getTrackRadio(createTrack('seed_1', 'youtube', 'Seed', 'Artist'), 10);
      expect(radio).toEqual([]);
    });

    it('player store startMyWave gracefully handles 0 returned recommendations in cold start without locking', async () => {
      (mockYtService.search as any).mockResolvedValue([]);
      (mockScService.search as any).mockResolvedValue([]);

      const store = usePlayerStore.getState();
      await store.startMyWave('chill', 'ambient');

      const updated = usePlayerStore.getState();
      expect(updated.queueMode).toBe('my_wave');
      expect(updated.isReplenishingQueue).toBe(false);
      expect(updated.sourceQueue).toEqual([]);
      expect(updated.currentIndex).toBe(-1);
    });
  });

  // =========================================================================
  // 2. High-Load Rapid Transitions & Concurrency Stress
  // =========================================================================
  describe('Dimension 2: High-Load Rapid Queue Transitions & Concurrency Stress', () => {
    it('survives 50 simultaneous concurrent replenishAutoplayQueue calls without duplicating queue or racing', async () => {
      const store = usePlayerStore.getState();
      const seed = createTrack('seed_t', 'youtube', 'Seed Track', 'The Prodigy', 210);

      // Start in track_radio mode
      await store.startTrackRadio(seed);

      // Fire 50 concurrent replenish calls
      const replenishPromises = Array.from({ length: 50 }, () =>
        usePlayerStore.getState().replenishAutoplayQueue()
      );

      await Promise.all(replenishPromises);

      const finalState = usePlayerStore.getState();
      expect(finalState.isReplenishingQueue).toBe(false);

      // Verify no duplicate IDs in sourceQueue
      const trackIds = finalState.sourceQueue.map((t) => t.id);
      const uniqueIds = new Set(trackIds);
      expect(trackIds.length).toBe(uniqueIds.size);
    });

    it('handles 100 rapid sequential skips (nextTrack) under My Wave mode without crash or desync', async () => {
      const tracks = Array.from({ length: 20 }, (_, i) =>
        createTrack(`track_${i}`, i % 2 === 0 ? 'youtube' : 'soundcloud', `Song ${i}`, `Artist ${i % 4}`, 200)
      );

      usePlayerStore.setState({
        queueMode: 'my_wave',
        autoplayRadio: true,
        sourceQueue: tracks,
        currentIndex: 0,
        currentTrack: tracks[0]
      });

      for (let i = 0; i < 100; i++) {
        await usePlayerStore.getState().nextTrack(true);
      }

      const finalState = usePlayerStore.getState();
      expect(finalState.playbackState).toBeDefined();
      expect(finalState.currentIndex).toBeGreaterThanOrEqual(-1);
      expect(finalState.currentIndex).toBeLessThanOrEqual(finalState.sourceQueue.length);
    });

    it('safely handles interleaved dislikeAndSkipCurrentTrack and rapid replenishment', async () => {
      const initialTracks = Array.from({ length: 5 }, (_, i) =>
        createTrack(`init_${i}`, 'youtube', `Initial Song ${i}`, `Artist ${i}`, 180)
      );

      usePlayerStore.setState({
        queueMode: 'track_radio',
        autoplayRadio: true,
        sourceQueue: [...initialTracks],
        currentIndex: 0,
        currentTrack: initialTracks[0]
      });

      // Dislike current track 4 times in rapid succession
      for (let i = 0; i < 4; i++) {
        await usePlayerStore.getState().dislikeAndSkipCurrentTrack();
      }

      const finalState = usePlayerStore.getState();
      // Ensure none of the disliked tracks remain in queue
      for (let i = 0; i < 4; i++) {
        expect(finalState.sourceQueue.some((t) => t.id === `init_${i}`)).toBe(false);
      }
      expect(finalState.currentIndex).toBeGreaterThanOrEqual(-1);
    });
  });

  // =========================================================================
  // 3. 100% Dislike Saturation & Malicious / Adversarial Track Metadata
  // =========================================================================
  describe('Dimension 3: 100% Dislike Saturation & Malicious Track Metadata', () => {
    it('strictly filters out 100% saturated disliked candidates from recommendations', async () => {
      // Dislike ALL potential candidates returned by mock services
      const allCandidateIds = ['yt_1', 'yt_2', 'yt_3', 'sc_1', 'sc_2', 'sc_3'];
      for (const id of allCandidateIds) {
        await addDislike(createTrack(id, 'youtube', `Title ${id}`, `Artist ${id}`));
      }

      const dislikedSet = await getDislikedTrackIds();
      expect(dislikedSet.size).toBe(6);

      const recs = await engine.getRecommendationsForWave({ mood: 'favorite' }, 10);

      // Disliked tracks MUST NEVER be present
      for (const r of recs) {
        expect(dislikedSet.has(r.id)).toBe(false);
      }
    });

    it('safely normalizes extreme Cyrillic, emoji, zalgo, and whitespace artist strings', () => {
      expect(normalizeArtist('Скриптонит & 104')).toBe('скриптонит 104');
      expect(normalizeArtist('КИНО / Виктор Цой')).toBe('кино виктор цой');
      expect(normalizeArtist('🔥🎧 DJ CyberBanger 🚀✨')).toBe('dj cyberbanger');
      expect(normalizeArtist('H̶̡́ë̴͎́l̵͔̿l̴̲̐o̸̝̓')).toBe('hello');
      expect(normalizeArtist('   \t\n   ')).toBe('');
      expect(normalizeArtist(null as any)).toBe('');
      expect(normalizeArtist(undefined as any)).toBe('');
      expect(normalizeArtist("Robert'); DROP TABLE tracks; --")).toBe('robert drop table tracks');
    });

    it('generates consistent dedupeKey for malformed and special-character tracks', () => {
      const cyrillicTrack = createTrack('c_1', 'youtube', 'Группа Крови (Remastered 2026)', 'КИНО');
      expect(dedupeKey(cyrillicTrack)).toBe('кино::группа крови remastered 2026');

      const emptyTrack: UnifiedTrack = {
        id: 'bad_1',
        source: 'youtube',
        originalId: 'bad_orig',
        title: '',
        artist: '',
        duration: 0,
        artworkUrl: ''
      };
      expect(dedupeKey(emptyTrack)).toBe('::');

      const nullFieldTrack = {
        id: 'null_1',
        source: 'soundcloud',
        originalId: 'null_orig',
        title: undefined as any,
        artist: null as any,
        duration: NaN
      } as unknown as UnifiedTrack;
      expect(() => dedupeKey(nullFieldTrack)).not.toThrow();
      expect(dedupeKey(nullFieldTrack)).toBe('::');
    });

    it('evaluates radio friendliness correctly across adversarial duration and title inputs', () => {
      // Normal track -> friendly
      expect(isRadioFriendly(createTrack('n1', 'youtube', 'Normal Track', 'Artist', 210))).toBe(true);

      // Long podcast / full album pattern -> unfriendly
      expect(isRadioFriendly(createTrack('lp1', 'youtube', 'Awesome Full Album 2026', 'Band', 240))).toBe(false);
      expect(isRadioFriendly(createTrack('lp2', 'youtube', 'Tech Podcast Episode 99', 'Speaker', 200))).toBe(false);
      expect(isRadioFriendly(createTrack('lp3', 'youtube', 'Non-stop Live DJ Set 10 Hours', 'DJ', 300))).toBe(false);

      // Duration bounds: < 30s or > 900s
      expect(isRadioFriendly(createTrack('s1', 'youtube', 'Short Intro', 'Artist', 10))).toBe(false);
      expect(isRadioFriendly(createTrack('s2', 'youtube', 'Huge Symphony', 'Artist', 1200))).toBe(false);

      // Invalid track objects
      expect(isRadioFriendly(null as any)).toBe(false);
      expect(isRadioFriendly({} as any)).toBe(false);
      expect(isRadioFriendly({ id: '' } as any)).toBe(false);
    });

    it('scores candidates with fuzzed and malicious metadata without producing NaN or throwing', async () => {
      const profile = await engine.buildUserProfile();
      const config: WaveConfig = { mood: 'focus', genre: 'lofi' };

      const fuzzedTracks: UnifiedTrack[] = [
        createTrack('f1', 'youtube', '', '', 0),
        createTrack('f2', 'soundcloud', '🔥 Banger 🚀', 'Special & Artist!', -100),
        createTrack('f3', 'youtube', 'Huge string '.repeat(1000), 'Long Artist '.repeat(500), NaN),
        createTrack('f4', 'soundcloud', 'SQL injection track', "'; DROP TABLE tracks; --", Infinity),
        {
          id: 'f5',
          source: 'youtube',
          originalId: 'f5',
          title: null as any,
          artist: undefined as any,
          duration: undefined as any
        } as unknown as UnifiedTrack
      ];

      for (const track of fuzzedTracks) {
        let scored: ScoredCandidate | null = null;
        expect(() => {
          scored = engine.scoreCandidate(track, config, profile);
        }).not.toThrow();

        expect(scored).toBeDefined();
        expect(Number.isFinite(scored!.score)).toBe(true);
        expect(isNaN(scored!.score)).toBe(false);
        expect(scored!.score).toBeGreaterThanOrEqual(0);
      }
    });

    it('handles recordFeedback with malformed track objects without throwing', async () => {
      const actions = ['like', 'dislike', 'skip', 'more_like_this', 'complete'] as const;

      for (const action of actions) {
        await expect(engine.recordFeedback(null as any, action)).resolves.not.toThrow();
        await expect(engine.recordFeedback({} as any, action)).resolves.not.toThrow();
        await expect(engine.recordFeedback({ id: '' } as any, action)).resolves.not.toThrow();
      }
    });
  });

  // =========================================================================
  // 4. Порядок выдачи: качество вперёд, разнообразие как ограничение
  // =========================================================================
  describe('Dimension 4: Ordering by score with artist and source diversity limits', () => {
    const makeScoredCandidate = (
      id: string,
      source: 'youtube' | 'soundcloud',
      score: number,
      artist: string = `Artist ${id}`
    ): ScoredCandidate => ({
      track: createTrack(id, source, `Track ${id}`, artist, 200),
      score,
      affinityScore: score,
      moodScore: score,
      noveltyScore: score,
      genreBonus: 0,
      recencyPenalty: 1.0
    });

    /** Порядок задаёт счёт, а не источник. */
    it('puts the highest scoring candidates first instead of alternating sources', () => {
      const candidates: ScoredCandidate[] = [
        makeScoredCandidate('yt_1', 'youtube', 0.9),
        makeScoredCandidate('yt_2', 'youtube', 0.8),
        makeScoredCandidate('yt_3', 'youtube', 0.7),
        makeScoredCandidate('sc_1', 'soundcloud', 0.3),
        makeScoredCandidate('sc_2', 'soundcloud', 0.2),
        makeScoredCandidate('sc_3', 'soundcloud', 0.1)
      ];

      const arranged: UnifiedTrack[] = (engine as any).arrangeCandidates(candidates, 6);

      expect(arranged.length).toBe(6);
      // Раньше здесь было yt, sc, yt, sc… и слабый SoundCloud занимал половину
      // выдачи только потому, что «его очередь».
      expect(arranged.slice(0, 3).map((t) => t.id)).toEqual(['yt_1', 'yt_2', 'yt_3']);
      expect(arranged.map((t) => t.id)).toEqual(['yt_1', 'yt_2', 'yt_3', 'sc_1', 'sc_2', 'sc_3']);
    });

    it('breaks up long runs from one source when the other has anything to offer', () => {
      const candidates: ScoredCandidate[] = [
        makeScoredCandidate('yt_1', 'youtube', 0.95),
        makeScoredCandidate('yt_2', 'youtube', 0.9),
        makeScoredCandidate('yt_3', 'youtube', 0.85),
        makeScoredCandidate('yt_4', 'youtube', 0.8),
        makeScoredCandidate('sc_1', 'soundcloud', 0.4)
      ];

      const arranged: UnifiedTrack[] = (engine as any).arrangeCandidates(candidates, 5);

      // Четвёртый YouTube подряд ждёт, пока пройдёт один SoundCloud: подряд
      // больше трёх с одного источника выдача не даёт.
      expect(arranged.map((t) => t.id)).toEqual(['yt_1', 'yt_2', 'yt_3', 'sc_1', 'yt_4']);
    });

    it('caps how many tracks one artist takes and spaces them apart', () => {
      const candidates: ScoredCandidate[] = [
        makeScoredCandidate('yt_1', 'youtube', 0.99, 'Same Artist'),
        makeScoredCandidate('yt_2', 'youtube', 0.98, 'Same Artist'),
        makeScoredCandidate('yt_3', 'youtube', 0.97, 'Same Artist'),
        makeScoredCandidate('yt_4', 'youtube', 0.5, 'Other One'),
        makeScoredCandidate('sc_1', 'soundcloud', 0.4, 'Other Two'),
        makeScoredCandidate('sc_2', 'soundcloud', 0.3, 'Other Three')
      ];

      const arranged: UnifiedTrack[] = (engine as any).arrangeCandidates(candidates, 4);

      expect(arranged.length).toBe(4);
      const sameArtistPositions = arranged
        .map((t, i) => (normalizeArtist(t.artist) === 'same artist' ? i : -1))
        .filter((i) => i >= 0);

      // Лимит на артиста в обычной волне — два трека, и не вплотную, хотя по
      // счёту все три его трека обгоняют остальных.
      expect(sameArtistPositions.length).toBe(2);
      expect(sameArtistPositions[1] - sameArtistPositions[0]).toBeGreaterThanOrEqual(3);
      expect(arranged[0].id).toBe('yt_1');
    });

    it('allows the seed artist more room in track radio than in a plain wave', () => {
      // Источники чередуются, чтобы правило «не больше трёх подряд с одного
      // источника» не мешало увидеть именно лимит на артиста.
      const candidates: ScoredCandidate[] = [
        ...Array.from({ length: 4 }, (_, i) =>
          makeScoredCandidate(`seed_${i}`, 'youtube', 0.9 - i * 0.01, 'Seed Artist')
        ),
        ...Array.from({ length: 20 }, (_, i) =>
          makeScoredCandidate(
            `other_${i}`,
            i % 2 === 0 ? 'youtube' : 'soundcloud',
            0.8 - i * 0.01,
            `Other ${i}`
          )
        )
      ];

      const wave: UnifiedTrack[] = (engine as any).arrangeCandidates(candidates, 10);
      const radio: UnifiedTrack[] = (engine as any).arrangeCandidates(candidates, 10, 3);

      const seedCount = (list: UnifiedTrack[]) =>
        list.filter((t) => normalizeArtist(t.artist) === 'seed artist').length;

      expect(seedCount(wave)).toBe(2);
      expect(seedCount(radio)).toBe(3);
    });

    it('still fills the whole limit when every candidate breaks a rule', () => {
      // Пятьдесят треков одного артиста с одного источника: ни одно ограничение
      // выполнить нельзя, и короткая волна здесь была бы хуже однообразной.
      const candidates = Array.from({ length: 50 }, (_, i) =>
        makeScoredCandidate(`yt_${i}`, 'youtube', 1.0 - i * 0.01, 'Only Artist')
      );

      const arranged: UnifiedTrack[] = (engine as any).arrangeCandidates(candidates, 10);

      expect(arranged.length).toBe(10);
      expect(new Set(arranged.map((t) => t.id)).size).toBe(10);
      expect(arranged[0].id).toBe('yt_0');
    });

    it('returns a single source in score order when the other one gave nothing', () => {
      const ytOnly = Array.from({ length: 50 }, (_, i) =>
        makeScoredCandidate(`yt_${i}`, 'youtube', 1.0 - i * 0.01)
      );
      const ytArranged: UnifiedTrack[] = (engine as any).arrangeCandidates(ytOnly, 10);
      expect(ytArranged.length).toBe(10);
      expect(ytArranged.every((t) => t.source === 'youtube')).toBe(true);
      expect(ytArranged.map((t) => t.id)).toEqual(ytOnly.slice(0, 10).map((c) => c.track.id));

      const scOnly = Array.from({ length: 50 }, (_, i) =>
        makeScoredCandidate(`sc_${i}`, 'soundcloud', 1.0 - i * 0.01)
      );
      const scArranged: UnifiedTrack[] = (engine as any).arrangeCandidates(scOnly, 10);
      expect(scArranged.length).toBe(10);
      expect(scArranged.every((t) => t.source === 'soundcloud')).toBe(true);
      expect(scArranged.map((t) => t.id)).toEqual(scOnly.slice(0, 10).map((c) => c.track.id));
    });

    it('handles heavily asymmetric candidate ratios (2 YT and 50 SC) cleanly up to limit', () => {
      const ytCandidates = [
        makeScoredCandidate('yt_1', 'youtube', 0.95),
        makeScoredCandidate('yt_2', 'youtube', 0.85)
      ];
      const scCandidates = Array.from({ length: 50 }, (_, i) =>
        makeScoredCandidate(`sc_${i}`, 'soundcloud', 0.9 - i * 0.01)
      );

      const arranged: UnifiedTrack[] = (engine as any).arrangeCandidates(
        [...ytCandidates, ...scCandidates],
        10
      );

      expect(arranged.length).toBe(10);
      expect(arranged[0].id).toBe('yt_1');
      // Двух YouTube не хватает, чтобы разбавлять SoundCloud до конца списка, —
      // и это нормально: остаток идёт по счёту.
      expect(arranged.filter((t) => t.source === 'youtube').length).toBe(2);
      expect(new Set(arranged.map((t) => t.id)).size).toBe(10);
    });

    it('stays ordered by score across 1000 candidates apart from diversity swaps', () => {
      const candidates = [
        ...Array.from({ length: 500 }, (_, i) => makeScoredCandidate(`yt_${i}`, 'youtube', 500 - i)),
        ...Array.from({ length: 500 }, (_, i) => makeScoredCandidate(`sc_${i}`, 'soundcloud', 500.5 - i))
      ];

      const limit = 100;
      const arranged: UnifiedTrack[] = (engine as any).arrangeCandidates(candidates, limit);

      expect(arranged.length).toBe(limit);
      expect(new Set(arranged.map((t) => t.id)).size).toBe(limit);

      // Каждый артист здесь уникален, поэтому единственное сработавшее правило —
      // серия одного источника, и отклонение от чистого порядка по счёту
      // остаётся мелким: выдача не перетасовывается.
      const scores = new Map(candidates.map((c) => [c.track.id, c.score]));
      const taken = arranged.map((t) => scores.get(t.id)!);
      const best = [...taken].sort((a, b) => b - a);
      for (let i = 0; i < taken.length; i++) {
        expect(best[i] - taken[i]).toBeLessThanOrEqual(2);
      }
    });

    it('returns empty array when limit is 0 or candidates array is empty', () => {
      const candidates = [makeScoredCandidate('yt_1', 'youtube', 0.9)];
      expect((engine as any).arrangeCandidates([], 10)).toEqual([]);
      expect((engine as any).arrangeCandidates(candidates, 0)).toEqual([]);
    });
  });
});
