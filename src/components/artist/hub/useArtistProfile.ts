import { useCallback, useEffect, useState } from 'react';
import { artistService, ArtistProfile } from '../../../services/artistService';
import { similarArtistsService, SimilarArtistsResult } from '../../../services/similarArtists';
import { isSubscribed, toggleSubscription } from '../../../services/subscriptions';

export interface ArtistProfileState {
  profile: ArtistProfile | null;
  isLoading: boolean;
  error: string | null;
  /** Загрузить профиль заново; `force` сбрасывает кэш, чтобы повтор не вернул то же самое. */
  loadProfile: (name: string, force?: boolean) => Promise<void>;
  /** Баннер не загрузился — шапка рисуется без фотографии. Сбрасывается при каждой загрузке. */
  bannerFailed: boolean;
  markBannerFailed: () => void;
  /** `null`, пока подбор ещё идёт — секция показывает скелет. */
  similar: SimilarArtistsResult | null;
  retrySimilar: () => void;
  subscribed: boolean;
  /** Переключает подписку и возвращает новое состояние — тост показывает экран. */
  toggleSubscribed: () => Promise<boolean>;
}

/**
 * Данные страницы исполнителя: профиль, похожие и подписка.
 *
 * Три загрузки намеренно независимы. Профиль — основа, без него нечего
 * показывать. Похожие идут следом и отдельно: часть источников сетевые, и
 * страница не должна ждать их, чтобы показать треки. Подписка читается по имени,
 * а не по профилю: имя известно сразу, и кнопка не мигает «не подписан» всё
 * время загрузки страницы.
 */
export function useArtistProfile(artistName: string): ArtistProfileState {
  const [profile, setProfile] = useState<ArtistProfile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [bannerFailed, setBannerFailed] = useState<boolean>(false);
  const [similar, setSimilar] = useState<SimilarArtistsResult | null>(null);
  const [similarAttempt, setSimilarAttempt] = useState<number>(0);
  const [subscribed, setSubscribed] = useState<boolean>(false);

  const loadProfile = useCallback(async (name: string, force = false) => {
    if (!name || !name.trim()) return;
    setIsLoading(true);
    setError(null);
    setBannerFailed(false);
    // Повтор после неудачи не должен получить тот же скудный результат, который
    // мы только что закэшировали, — иначе кнопка «Повторить» ничего не делает.
    if (force) artistService.clearCache();
    try {
      const data = await artistService.getArtistProfile(name);
      setProfile(data);
    } catch (err: unknown) {
      console.warn('[ArtistHubView] Failed to load artist profile:', err);
      const msg = err instanceof Error ? err.message : 'Не удалось загрузить профиль исполнителя';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (artistName) {
      void loadProfile(artistName);
    }
  }, [artistName, loadProfile]);

  // Флаг `cancelled` нужен, потому что переход на другого артиста меняет
  // профиль раньше, чем вернётся прошлый подбор.
  useEffect(() => {
    if (!profile || profile.isSparse) return;

    let cancelled = false;
    setSimilar(null);

    similarArtistsService
      .getSimilarArtists({
        artistName: profile.name,
        topTracks: profile.topTracks,
        fromProfile: profile.similarArtists
      })
      .then((result) => {
        if (!cancelled) setSimilar(result);
      })
      .catch((err: unknown) => {
        console.warn('[ArtistHubView] Похожих исполнителей собрать не удалось:', err);
        if (!cancelled) setSimilar({ artists: [], status: 'unavailable' });
      });

    return () => {
      cancelled = true;
    };
  }, [profile, similarAttempt]);

  useEffect(() => {
    let cancelled = false;
    void isSubscribed(artistName).then((value) => {
      if (!cancelled) setSubscribed(value);
    });
    return () => {
      cancelled = true;
    };
  }, [artistName]);

  const toggleSubscribed = useCallback(async () => {
    const name = profile?.name || artistName;
    const next = await toggleSubscription(name, {
      avatarUrl: profile?.avatarUrl,
      channelId: profile?.channelId
    });
    setSubscribed(next);
    return next;
  }, [artistName, profile]);

  const retrySimilar = useCallback(() => {
    if (!profile) return;
    // Без сброса кэша повторная попытка вернула бы тот же пустой ответ.
    similarArtistsService.clearCache(profile.name);
    setSimilarAttempt((attempt) => attempt + 1);
  }, [profile]);

  const markBannerFailed = useCallback(() => setBannerFailed(true), []);

  return {
    profile,
    isLoading,
    error,
    loadProfile,
    bannerFailed,
    markBannerFailed,
    similar,
    retrySimilar,
    subscribed,
    toggleSubscribed
  };
}
