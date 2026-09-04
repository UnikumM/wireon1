import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../setup';
import {
  RecommendationEngineService,
  recommendationEngine,
  normalizeArtist,
  dedupeKey,
  isRadioFriendly,
  isTopUpEligible,
  hasPollutedTitle,
  WaveConfig
} from '../../src/services/recommendationEngine';
import {
  clearAllData,
  addFavorite,
  addToHistory,
  createPlaylist,
  addTrackToPlaylist,
  addDislike,
  isDisliked,
  isFavorite,
  getHistory
} from '../../src/services/db';
import { UnifiedTrack } from '../../src/types/music';
import { YouTubeService } from '../../src/services/youtube';
import { SoundCloudService } from '../../src/services/soundcloud';

const mockYtTrack1: UnifiedTrack = {
  id: 'yt_track1',
  source: 'youtube',
  originalId: 'track1',
  title: 'Cyberpunk Workout Theme',
  artist: 'Synth Master',
  duration: 210,
  artworkUrl: 'https://example.com/yt1.jpg'
};

const mockYtTrack2: UnifiedTrack = {
  id: 'yt_track2',
  source: 'youtube',
  originalId: 'track2',
  title: 'Lofi Study Beats for Coding',
  artist: 'Chill Cat',
  duration: 180,
  artworkUrl: 'https://example.com/yt2.jpg'
};

const mockYtLongTrack: UnifiedTrack = {
  id: 'yt_long',
  source: 'youtube',
  originalId: 'long_yt',
  title: 'Full Album 24/7 Live Stream Mix',
  artist: 'DJ Mega',
  duration: 7200,
  artworkUrl: 'https://example.com/yt_long.jpg'
};

const mockScTrack1: UnifiedTrack = {
  id: 'sc_track1',
  source: 'soundcloud',
  originalId: 'track1_sc',
  title: 'Ambient Relax Acoustic Sunset',
  artist: 'Acoustic Wave',
  duration: 240,
  artworkUrl: 'https://example.com/sc1.jpg'
};

const mockScTrack2: UnifiedTrack = {
  id: 'sc_track2',
  source: 'soundcloud',
  originalId: 'track2_sc',
  title: 'Fresh Indie Rock Discovery',
  artist: 'New Horizon',
  duration: 195,
  artworkUrl: 'https://example.com/sc2.jpg'
};

const mockScPodcastTrack: UnifiedTrack = {
  id: 'sc_podcast',
  source: 'soundcloud',
  originalId: 'podcast_sc',
  title: 'Music Talk Podcast Episode 42',
  artist: 'Talk Show',
  duration: 1200,
  artworkUrl: 'https://example.com/sc_pod.jpg'
};

describe('RecommendationEngineService', () => {
  let mockYtService: YouTubeService;
  let mockScService: SoundCloudService;
  let engine: RecommendationEngineService;

  beforeEach(async () => {
    await clearAllData();

    mockYtService = {
      search: vi.fn().mockResolvedValue([mockYtTrack1, mockYtTrack2]),
      getRelatedVideos: vi.fn().mockResolvedValue([mockYtTrack1, mockYtTrack2]),
      getSuggestions: vi.fn().mockResolvedValue([]),
      resolveStreamUrl: vi.fn().mockResolvedValue({
        streamUrl: 'https://stream.youtube.test',
        format: 'm4a',
        bitrate: 160,
        expiresAt: Date.now() + 3600000
      })
    } as unknown as YouTubeService;

    mockScService = {
      search: vi.fn().mockResolvedValue([mockScTrack1, mockScTrack2]),
      getRelatedTracks: vi.fn().mockResolvedValue([mockScTrack1, mockScTrack2]),
      getClientId: vi.fn().mockResolvedValue('mock_client_id'),
      resolveStreamUrl: vi.fn().mockResolvedValue({
        streamUrl: 'https://stream.soundcloud.test',
        format: 'mp3',
        bitrate: 128,
        expiresAt: Date.now() + 3600000
      })
    } as unknown as SoundCloudService;

    engine = new RecommendationEngineService(mockYtService, mockScService);
    engine.resetSessionBoosts();
  });

  afterEach(async () => {
    await clearAllData();
  });

  describe('Utility & Filtering Functions', () => {
    it('normalizes artist strings cleanly', () => {
      expect(normalizeArtist('  Daft Punk!  ')).toBe('daft punk');
      expect(normalizeArtist('Hans Zimmer / OST')).toBe('hans zimmer ost');
      expect(normalizeArtist('КИНО')).toBe('кино');
      expect(normalizeArtist('')).toBe('');
    });

    it('generates consistent dedupe keys', () => {
      expect(dedupeKey(mockYtTrack1)).toBe('synth master::cyberpunk workout theme');
    });

    it('evaluates radio friendliness correctly', () => {
      expect(isRadioFriendly(mockYtTrack1)).toBe(true);
      expect(isRadioFriendly(mockScTrack1)).toBe(true);

      // Excludes multi-hour full albums or long podcasts
      expect(isRadioFriendly(mockYtLongTrack)).toBe(false);
      expect(isRadioFriendly(mockScPodcastTrack)).toBe(false);

      // Excludes tracks shorter than 30s
      const shortTrack: UnifiedTrack = { ...mockYtTrack1, duration: 15 };
      expect(isRadioFriendly(shortTrack)).toBe(false);
    });

    it('evaluates top-up eligibility for relaxed fallback pools', () => {
      expect(isTopUpEligible(mockYtTrack1)).toBe(true);
      expect(isTopUpEligible(mockScPodcastTrack)).toBe(true); // 1200s < 1800s
      expect(isTopUpEligible(mockYtLongTrack)).toBe(false); // 7200s > 1800s
    });

    it('rejects karaoke, pitched re-uploads and lessons, but keeps ordinary titles', () => {
      const withTitle = (title: string): UnifiedTrack => ({ ...mockYtTrack1, title });

      for (const title of [
        'Song Name (Karaoke Version)',
        'Song Name - Sped Up',
        'Song Name [8D AUDIO]',
        'Song Name (Nightcore)',
        'Song Name (Slowed + Reverb)',
        'Song Name - Slowed Down',
        'Song Name (Instrumental Version)',
        'Song Name acoustic cover',
        'Song Name cover by SomeoneElse',
        'How To Play Song Name on guitar',
        'Song Name guitar lesson',
        'Song Name ringtone',
        'Reacts To Song Name'
      ]) {
        expect(isRadioFriendly(withTitle(title)), title).toBe(false);
        expect(hasPollutedTitle(withTitle(title)), title).toBe(true);
      }

      // Обычные названия фильтр не задевает — в том числе те, где просто есть
      // слова «cover», «reaction» или «acoustic».
      for (const title of [
        'Chain Reaction',
        'Cover Me In Sunshine',
        'Ambient Relax Acoustic Sunset',
        'Instrumental Sunrise',
        'Slow Dancing In The Dark'
      ]) {
        expect(isRadioFriendly(withTitle(title)), title).toBe(true);
        expect(hasPollutedTitle(withTitle(title)), title).toBe(false);
      }
    });
  });

  describe('User Profile & Artist Affinity Scoring', () => {
    it('computes artist affinity using W_artist = playCount + 3.0 * isFavorite + 1.5 * inPlaylist', async () => {
      // 1. Play "Synth Master" 3 times in history
      await addToHistory(mockYtTrack1);
      await addToHistory(mockYtTrack1);
      await addToHistory(mockYtTrack1);

      // 2. Favorite 2 tracks by "Synth Master" (3.0 * 2 = 6.0)
      await addFavorite(mockYtTrack1);
      await addFavorite({ ...mockYtTrack1, id: 'yt_track1_b', title: 'Second Song' });

      // 3. Add 1 track by "Synth Master" to a playlist (1.5 * 1 = 1.5)
      const pl = await createPlaylist('Workout Vibes');
      await addTrackToPlaylist(pl.id, mockYtTrack1);

      // Expected Affinity: 3 (plays) + 6.0 (favorites) + 1.5 (playlist) = 10.5
      const profile = await engine.buildUserProfile();
      const normArtist = normalizeArtist(mockYtTrack1.artist);

      expect(profile.artistAffinities.get(normArtist)).toBeCloseTo(10.5);
      expect(profile.topArtists[0]).toBe(normArtist);
      expect(profile.favoriteTrackIds.has(mockYtTrack1.id)).toBe(true);
      expect(profile.recentTrackIds.has(mockYtTrack1.id)).toBe(true);
      expect(profile.totalPlays).toBe(3);
    });

    it('builds a clean empty profile on fresh user state', async () => {
      const profile = await engine.buildUserProfile();
      expect(profile.totalPlays).toBe(0);
      expect(profile.topArtists).toEqual([]);
      expect(profile.favoriteTrackIds.size).toBe(0);
      expect(profile.dislikedTrackIds.size).toBe(0);
      expect(profile.recentTrackIds.size).toBe(0);
    });

    it('includes disliked track IDs in user profile', async () => {
      await addDislike(mockYtTrack1);
      const profile = await engine.buildUserProfile();
      expect(profile.dislikedTrackIds.has(mockYtTrack1.id)).toBe(true);
    });

    it('отказ опускает вес артиста, а не поднимает его', async () => {
      /*
       * Так эта поломка выглядела у людей: «говорю не суй мне это, а оно ещё
       * больше хуярит». Причина была в знаке. Вес складывался только из
       * прослушиваний, избранного и плейлистов, а в историю трек попадает в тот
       * же миг, когда начал играть, — значит **каждая выдача поднимала вес**.
       * Отказ убирал ровно один идентификатор и на артиста не влиял никак,
       * а `topArtists` порождает запросы, которыми волна добирает треки.
       */
      await addToHistory(mockYtTrack1);
      const liked = await engine.buildUserProfile();
      const norm = normalizeArtist(mockYtTrack1.artist);
      const before = liked.artistAffinities.get(norm) ?? 0;

      await engine.recordFeedback(mockYtTrack1, 'dislike');
      const after = await engine.buildUserProfile();

      expect(after.artistAffinities.get(norm)!).toBeLessThan(before);
      expect(after.topArtists).not.toContain(norm);
    });

    it('дважды выключенный артист перестаёт быть семенем для запросов', async () => {
      // Один пропуск — можно просто не угадать момент; два подряд это уже ответ.
      await addToHistory(mockYtTrack2);
      await engine.recordFeedback(mockYtTrack2, 'skip');
      await engine.recordFeedback(mockYtTrack2, 'skip');
      await engine.recordFeedback(mockYtTrack2, 'skip');

      const profile = await engine.buildUserProfile();
      expect(profile.topArtists).not.toContain(normalizeArtist(mockYtTrack2.artist));
    });

    it('любимого артиста один пропуск из топа не выбивает', async () => {
      // Штраф обязан быть соразмерным: иначе случайное переключение стирало бы
      // то, что человек слушает годами.
      await addToHistory(mockYtTrack1);
      await addToHistory(mockYtTrack1);
      await addFavorite(mockYtTrack1);
      await engine.recordFeedback(mockYtTrack1, 'skip');

      const profile = await engine.buildUserProfile();
      expect(profile.topArtists).toContain(normalizeArtist(mockYtTrack1.artist));
    });
  });

  describe('Feedback Handling (recordFeedback)', () => {
    it('handles "like" action by adding to favorites', async () => {
      await engine.recordFeedback(mockYtTrack1, 'like');
      expect(await isFavorite(mockYtTrack1.id)).toBe(true);
    });

    it('handles "dislike" action by adding to dislikes and recording a skip', async () => {
      await addToHistory(mockYtTrack1);
      await engine.recordFeedback(mockYtTrack1, 'dislike');

      expect(await isDisliked(mockYtTrack1.id)).toBe(true);
      const history = await getHistory();
      const record = history.find((h) => h.id === mockYtTrack1.id);
      expect(record?.skipCount).toBe(1);
    });

    it('handles "skip" action by recording skip in history', async () => {
      await addToHistory(mockYtTrack1);
      await engine.recordFeedback(mockYtTrack1, 'skip');

      const history = await getHistory();
      const record = history.find((h) => h.id === mockYtTrack1.id);
      expect(record?.skipCount).toBe(1);
    });

    it('handles "complete" action by recording completion in history', async () => {
      await addToHistory(mockYtTrack1);
      await engine.recordFeedback(mockYtTrack1, 'complete');

      const history = await getHistory();
      const record = history.find((h) => h.id === mockYtTrack1.id);
      expect(record?.completedCount).toBe(1);
    });

    it('handles "more_like_this" action by boosting artist affinity in session', async () => {
      await engine.recordFeedback(mockYtTrack1, 'more_like_this');
      const profile = await engine.buildUserProfile();
      const normArtist = normalizeArtist(mockYtTrack1.artist);

      expect(profile.artistAffinities.get(normArtist)).toBeGreaterThanOrEqual(5.0);
      expect(profile.topArtists).toContain(normArtist);
    });
  });

  describe('Candidate Scoring Matrix & Mood Weights', () => {
    it('scores favorite mood candidates higher for top artists and favorites', async () => {
      await addFavorite(mockYtTrack1);
      const profile = await engine.buildUserProfile();

      const config: WaveConfig = { mood: 'favorite' };
      const scoredFav = engine.scoreCandidate(mockYtTrack1, config, profile);
      const scoredOther = engine.scoreCandidate(mockScTrack2, config, profile);

      expect(scoredFav.score).toBeGreaterThan(scoredOther.score);
      expect(scoredFav.moodScore).toBe(1.0);
    });

    it('scores discovery mood candidates higher for unplayed/novel artists', async () => {
      await addToHistory(mockYtTrack1);
      const profile = await engine.buildUserProfile();

      const config: WaveConfig = { mood: 'discovery' };
      const scoredKnown = engine.scoreCandidate(mockYtTrack1, config, profile);
      const scoredNovel = engine.scoreCandidate(mockScTrack2, config, profile);

      expect(scoredNovel.score).toBeGreaterThan(scoredKnown.score);
      expect(scoredNovel.noveltyScore).toBe(1.0);
    });

    it('applies mood keyword matching for energy, chill, and focus moods', async () => {
      const profile = await engine.buildUserProfile();

      // Energy mood should match "Workout" in mockYtTrack1 title
      const energyConfig: WaveConfig = { mood: 'energy' };
      const scoredEnergy = engine.scoreCandidate(mockYtTrack1, energyConfig, profile);
      expect(scoredEnergy.moodScore).toBeGreaterThan(0.5);

      // Chill mood should match "Relax" and "Acoustic" in mockScTrack1 title
      const chillConfig: WaveConfig = { mood: 'chill' };
      const scoredChill = engine.scoreCandidate(mockScTrack1, chillConfig, profile);
      expect(scoredChill.moodScore).toBeGreaterThan(0.5);

      // Focus mood should match "Study" and "Coding" in mockYtTrack2 title
      const focusConfig: WaveConfig = { mood: 'focus' };
      const scoredFocus = engine.scoreCandidate(mockYtTrack2, focusConfig, profile);
      expect(scoredFocus.moodScore).toBeGreaterThan(0.5);
    });

    it('applies genre bonus when candidate matches specified genre', async () => {
      const profile = await engine.buildUserProfile();
      const configWithGenre: WaveConfig = { mood: 'energy', genre: 'Workout' };
      const scored = engine.scoreCandidate(mockYtTrack1, configWithGenre, profile);

      expect(scored.genreBonus).toBe(0.25);
    });

    it('applies history recency penalty to recently played tracks', async () => {
      await addToHistory(mockYtTrack1);
      const profile = await engine.buildUserProfile();

      const config: WaveConfig = { mood: 'energy' };
      const scoredWithPenalty = engine.scoreCandidate(mockYtTrack1, config, profile);

      expect(scoredWithPenalty.recencyPenalty).toBeLessThanOrEqual(0.2);
    });

    it('penalises tracks that were repeatedly skipped and never finished', async () => {
      // Два пропуска без единого доигранного раза — это отказ, просто без
      // нажатия на «не нравится». До этой правки skipCount писался в историю и
      // никем не читался, и волна возвращала трек снова и снова.
      await addToHistory(mockYtTrack1);
      await addToHistory(mockYtTrack2);
      await engine.recordFeedback(mockYtTrack1, 'skip');
      await engine.recordFeedback(mockYtTrack1, 'skip');

      const profile = await engine.buildUserProfile();
      expect(profile.skippedTrackIds?.has(mockYtTrack1.id)).toBe(true);
      expect(profile.skippedTrackIds?.has(mockYtTrack2.id)).toBe(false);

      const config: WaveConfig = { mood: 'favorite' };
      const skipped = engine.scoreCandidate(mockYtTrack1, config, profile);
      const kept = engine.scoreCandidate(mockYtTrack2, config, profile);

      expect(skipped.skipPenalty).toBeLessThan(1);
      expect(kept.skipPenalty).toBe(1);
      expect(skipped.score).toBeLessThan(kept.score);
    });

    it('forgives skips once the track has been played through more often', async () => {
      await addToHistory(mockYtTrack1);
      await engine.recordFeedback(mockYtTrack1, 'skip');
      await engine.recordFeedback(mockYtTrack1, 'skip');
      await engine.recordFeedback(mockYtTrack1, 'complete');
      await engine.recordFeedback(mockYtTrack1, 'complete');
      await engine.recordFeedback(mockYtTrack1, 'complete');

      const profile = await engine.buildUserProfile();
      expect(profile.skippedTrackIds?.has(mockYtTrack1.id)).toBe(false);
      expect(engine.scoreCandidate(mockYtTrack1, { mood: 'favorite' }, profile).skipPenalty).toBe(1);
    });
  });

  describe('Dislike and Exclusion Filtering', () => {
    it('strictly filters out disliked tracks from Wave recommendations', async () => {
      await addDislike(mockYtTrack1);

      const config: WaveConfig = { mood: 'energy' };
      const recommendations = await engine.getRecommendationsForWave(config, 10);

      const foundDisliked = recommendations.some((t) => t.id === mockYtTrack1.id);
      expect(foundDisliked).toBe(false);
    });

    it('strictly filters out explicit excludeIds from Wave recommendations', async () => {
      const config: WaveConfig = { mood: 'energy' };
      const excludeIds = new Set<string>([mockYtTrack1.id]);
      const recommendations = await engine.getRecommendationsForWave(config, 10, excludeIds);

      expect(recommendations.some((t) => t.id === mockYtTrack1.id)).toBe(false);
    });

    it('strictly excludes seed track and dislikes from Track Radio', async () => {
      await addDislike(mockScTrack1);

      const radio = await engine.getTrackRadio(mockYtTrack1, 10);
      expect(radio.some((t) => t.id === mockYtTrack1.id)).toBe(false);
      expect(radio.some((t) => t.id === mockScTrack1.id)).toBe(false);
    });
  });

  describe('Multi-Source Aggregation & Diversity Limits', () => {
    it('lets score decide the order instead of alternating sources 1:1', async () => {
      const config: WaveConfig = { mood: 'energy' };
      const recs = await engine.getRecommendationsForWave(config, 4);

      expect(recs.length).toBeGreaterThanOrEqual(2);
      // Both sources still reach the wave — they are simply not forced to split
      // it in half regardless of how well their candidates scored.
      const sources = new Set(recs.map((t) => t.source));
      expect(sources.size).toBeGreaterThanOrEqual(1);
      // No duplicates and nothing empty slipped through.
      expect(new Set(recs.map((t) => t.id)).size).toBe(recs.length);
      expect(recs.every((t) => Boolean(t.id))).toBe(true);
    });

    it('does not let one artist fill the whole wave', async () => {
      // Every search answer is the same artist: the old code happily returned
      // ten tracks by them, which reads as a stuck playlist.
      const sameArtist: UnifiedTrack[] = Array.from({ length: 8 }, (_, i) => ({
        ...mockYtTrack1,
        id: `yt_same_${i}`,
        originalId: `same_${i}`,
        title: `Workout Anthem ${i}`
      }));
      (mockYtService.search as any).mockResolvedValue(sameArtist);
      (mockScService.search as any).mockResolvedValue([mockScTrack1, mockScTrack2]);

      const recs = await engine.getRecommendationsForWave({ mood: 'energy' }, 4);
      const byArtist = recs.filter((t) => normalizeArtist(t.artist) === normalizeArtist(mockYtTrack1.artist));

      expect(recs.length).toBe(4);
      expect(byArtist.length).toBeLessThanOrEqual(2);
    });

    it('keeps karaoke, sped up and 8D re-uploads out of the wave', async () => {
      const pollution: UnifiedTrack[] = [
        { ...mockYtTrack1, id: 'yt_karaoke', title: 'Cyberpunk Theme (Karaoke Version)' },
        { ...mockYtTrack1, id: 'yt_sped', title: 'Cyberpunk Theme - Sped Up' },
        { ...mockYtTrack1, id: 'yt_8d', title: 'Cyberpunk Theme [8D AUDIO]' },
        { ...mockYtTrack1, id: 'yt_nightcore', title: 'Cyberpunk Theme (Nightcore)' },
        { ...mockYtTrack1, id: 'yt_slowed', title: 'Cyberpunk Theme (Slowed + Reverb)' },
        { ...mockYtTrack1, id: 'yt_cover', title: 'Cyberpunk Theme - acoustic cover' },
        { ...mockYtTrack1, id: 'yt_clean', title: 'Cyberpunk Theme' }
      ];
      (mockYtService.search as any).mockResolvedValue(pollution);
      (mockScService.search as any).mockResolvedValue([]);

      const recs = await engine.getRecommendationsForWave({ mood: 'energy' }, 10);

      expect(recs.map((t) => t.id)).toEqual(['yt_clean']);
    });

    it('gracefully falls back when YouTube service throws an error', async () => {
      (mockYtService.search as any).mockRejectedValue(new Error('YT Network Error'));

      const config: WaveConfig = { mood: 'chill' };
      const recs = await engine.getRecommendationsForWave(config, 5);

      expect(recs.length).toBeGreaterThan(0);
      expect(recs.every((t) => t.source === 'soundcloud')).toBe(true);
    });

    it('gracefully falls back when SoundCloud service throws an error', async () => {
      (mockScService.search as any).mockRejectedValue(new Error('SC Network Error'));

      const config: WaveConfig = { mood: 'focus' };
      const recs = await engine.getRecommendationsForWave(config, 5);

      expect(recs.length).toBeGreaterThan(0);
      expect(recs.every((t) => t.source === 'youtube')).toBe(true);
    });
  });

  describe('Track Radio Chaining', () => {
    it('generates related tracks chaining from YouTube seed track', async () => {
      const radio = await engine.getTrackRadio(mockYtTrack1, 5);

      expect(mockYtService.getRelatedVideos).toHaveBeenCalledWith(mockYtTrack1.originalId, expect.any(Number));
      expect(radio.length).toBeGreaterThan(0);
      expect(radio.some((t) => t.id === mockYtTrack1.id)).toBe(false);
    });

    it('generates related tracks chaining from SoundCloud seed track', async () => {
      const radio = await engine.getTrackRadio(mockScTrack1, 5);

      expect(mockScService.getRelatedTracks).toHaveBeenCalledWith(mockScTrack1.originalId, expect.any(Number));
      expect(radio.length).toBeGreaterThan(0);
      expect(radio.some((t) => t.id === mockScTrack1.id)).toBe(false);
    });

    it('returns empty array if seedTrack is missing', async () => {
      const radio = await engine.getTrackRadio(null as unknown as UnifiedTrack);
      expect(radio).toEqual([]);
    });
  });

  describe('Радио от песни не разбавляется поиском', () => {
    /** Пачка непохожих друг на друга годных треков одного «жанра». */
    const phonkBatch = (count: number, tag: string): UnifiedTrack[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `yt_${tag}${i}`,
        source: 'youtube' as const,
        originalId: `${tag}${i}`,
        title: `Phonk Track ${tag}${i}`,
        artist: `Phonk Artist ${tag}${i}`,
        duration: 150 + i,
        artworkUrl: 'https://example.com/p.jpg'
      }));

    const phonkSeed: UnifiedTrack = {
      id: 'yt_seed_phonk',
      source: 'youtube',
      originalId: 'seed_phonk',
      title: 'Murder In My Mind',
      artist: 'Kordhell',
      duration: 160,
      artworkUrl: 'https://example.com/seed.jpg'
    };

    it('не ищет по ключевым словам, когда радио ответило', async () => {
      // Так отвечает настоящее радио YouTube Music: список того же жанра.
      mockYtService.getRelatedVideos = vi.fn().mockResolvedValue(phonkBatch(20, 'a'));

      const recs = await engine.getRecommendationsForWave(
        { mood: 'energy', seedTrack: phonkSeed, seedKind: 'library' } as WaveConfig,
        10
      );

      // Именно этот поиск раньше растворял фонк во «всём подряд».
      expect(mockYtService.search).not.toHaveBeenCalled();
      expect(mockScService.search).not.toHaveBeenCalled();
      expect(recs.length).toBeGreaterThan(0);
      expect(recs.every((t) => t.title.startsWith('Phonk Track'))).toBe(true);
    });

    it('продлевает скупое радио радио же, а не поиском', async () => {
      const related = vi
        .fn()
        // Первый ответ короткий: до порога не дотягивает.
        .mockResolvedValueOnce(phonkBatch(3, 'a'))
        .mockResolvedValue(phonkBatch(12, 'b'));
      mockYtService.getRelatedVideos = related;

      const recs = await engine.getRecommendationsForWave(
        { mood: 'energy', seedTrack: phonkSeed, seedKind: 'library' } as WaveConfig,
        10
      );

      // Второй вызов — зацепка за трек из первой пачки, а не за семя.
      expect(related.mock.calls.length).toBeGreaterThan(1);
      expect(related.mock.calls[1][0]).toBe('a0');
      expect(mockYtService.search).not.toHaveBeenCalled();
      expect(recs.length).toBeGreaterThan(0);
    });

    it('всё-таки ищет, когда радио молчит совсем', async () => {
      mockYtService.getRelatedVideos = vi.fn().mockResolvedValue([]);

      const recs = await engine.getRecommendationsForWave(
        { mood: 'energy', seedTrack: phonkSeed, seedKind: 'library' } as WaveConfig,
        10
      );

      expect(mockYtService.search).toHaveBeenCalled();
      expect(recs.length).toBeGreaterThan(0);
    });

    it('не ищет по «артист + название» в автопотоке, когда радио ответило', async () => {
      mockYtService.getRelatedVideos = vi.fn().mockResolvedValue(phonkBatch(20, 'a'));

      const radio = await engine.getTrackRadio(phonkSeed, 10);

      expect(mockYtService.search).not.toHaveBeenCalled();
      expect(radio.length).toBeGreaterThan(0);
      expect(radio.some((t) => t.id === phonkSeed.id)).toBe(false);
    });

    it('не зацикливается, когда радио повторяет одно и то же', async () => {
      // Одна и та же пачка на каждый запрос: новых треков не появляется.
      mockYtService.getRelatedVideos = vi.fn().mockResolvedValue(phonkBatch(2, 'a'));

      const radio = await engine.getTrackRadio(phonkSeed, 10);

      // Продление прекращается, а не ходит по кругу до бесконечности.
      expect((mockYtService.getRelatedVideos as any).mock.calls.length).toBeLessThanOrEqual(3);
      expect(radio.length).toBeGreaterThan(0);
    });
  });

  describe('Singleton Export & Compatibility', () => {
    it('exports recommendationEngine singleton instance', () => {
      expect(recommendationEngine).toBeDefined();
      expect(typeof recommendationEngine.getRecommendationsForWave).toBe('function');
      expect(typeof recommendationEngine.getTrackRadio).toBe('function');
      expect(typeof recommendationEngine.recordFeedback).toBe('function');
      expect(typeof recommendationEngine.buildUserProfile).toBe('function');
    });
  });
});
