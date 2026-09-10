/**
 * Вход в Spotify (`src/services/spotifyAuth.ts`).
 *
 * Проверяется то, что ломает вход молча: подменённый ответ на адрес возврата,
 * протухший токен, который никто не обновил, и отказ человека, показанный как
 * ошибка программы.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildAuthUrl,
  createCodeChallenge,
  createCodeVerifier,
  getFreshAccessToken,
  isExpired,
  loadSession,
  parseCallbackUrl,
  saveSession,
  SPOTIFY_REDIRECT_URI
} from '../../src/services/spotifyAuth';

describe('spotifyAuth', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('строит адрес согласия с проверочной загадкой и адресом возврата', async () => {
    const verifier = createCodeVerifier();
    const challenge = await createCodeChallenge(verifier);
    const url = new URL(buildAuthUrl('client-1', challenge, 'state-1'));

    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('redirect_uri')).toBe(SPOTIFY_REDIRECT_URI);
    // Прав просим ровно на чтение — ни изменения, ни воспроизведения.
    expect(url.searchParams.get('scope')).toBe(
      'playlist-read-private playlist-read-collaborative user-library-read'
    );
  });

  it('загадка отличается от исходной строки и не содержит символов, ломающих адрес', async () => {
    const verifier = createCodeVerifier();
    const challenge = await createCodeChallenge(verifier);
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('разбирает возврат: код, отказ и мусор', () => {
    expect(parseCallbackUrl('wireon://spotify/callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
      error: undefined
    });
    expect(parseCallbackUrl('wireon://spotify/callback?error=access_denied').error).toBe('access_denied');
    expect(parseCallbackUrl('это не адрес').error).toBeTruthy();
  });

  it('считает токен протухшим заранее, а не в последнюю секунду', () => {
    const now = 1_000_000;
    // Запрос с токеном, которому осталось полминуты, не успеет дойти.
    expect(isExpired({ accessToken: 'a', refreshToken: null, expiresAt: now + 30_000 }, now)).toBe(true);
    expect(isExpired({ accessToken: 'a', refreshToken: null, expiresAt: now + 600_000 }, now)).toBe(false);
  });

  it('обновляет протухший токен и сохраняет новый', async () => {
    saveSession({ accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() - 1000 });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh', expires_in: 3600 })
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await getFreshAccessToken('client-1');

    expect(token).toBe('fresh');
    // Ключ обновления Spotify возвращает не всегда — старый обязан сохраниться.
    expect(loadSession()?.refreshToken).toBe('refresh-1');
  });

  it('забывает вход, когда обновить его не вышло', async () => {
    saveSession({ accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() - 1000 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error_description: 'revoked' }) })
    );

    expect(await getFreshAccessToken('client-1')).toBeNull();
    // Иначе приложение бесконечно ходило бы с мёртвым ключом.
    expect(loadSession()).toBeNull();
  });

  it('без входа ничего не выдумывает', async () => {
    expect(await getFreshAccessToken('client-1')).toBeNull();
  });
});
