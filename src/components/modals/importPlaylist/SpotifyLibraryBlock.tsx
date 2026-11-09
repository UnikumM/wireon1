import React, { useState } from 'react';
import { getClientId, getFreshAccessToken, runSpotifyLogin } from '../../../services/spotifyAuth';
import { fetchLikedSongs, fetchPlaylists, SpotifyPlaylistSummary } from '../../../services/spotifyLibrary';
import type { ParsedPlaylistItem } from '../../../services/playlistImporter';
import { Button } from '../../common/Button';
import { readSpotifyPlaylist } from './readSources';

/**
 * Импорт из Spotify по-настоящему: через вход, а не через публичную страницу.
 *
 * Разбор ссылки рядом читает страницу плейлиста, а она отдаёт первую сотню
 * треков и ничего не знает про «Любимые» и приватные списки. Отсюда же
 * приезжает всё целиком.
 */
export const SpotifyLibraryBlock: React.FC<{ onPicked: (title: string, items: ParsedPlaylistItem[]) => void }> = ({
  onPicked
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<SpotifyPlaylistSummary[] | null>(null);

  const available = Boolean(getClientId()) && typeof window !== 'undefined' && Boolean(window.electronAPI?.onDeepLink);
  if (!available) return null;

  const load = async (token: string) => {
    setPlaylists(await fetchPlaylists(token));
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const token = (await getFreshAccessToken()) || (await runSpotifyLogin()).accessToken;
      await load(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (kind: 'liked' | 'playlist', playlist?: SpotifyPlaylistSummary) => {
    setBusy(true);
    setError(null);
    try {
      let items: ParsedPlaylistItem[];
      if (kind === 'liked') {
        const token = await getFreshAccessToken();
        if (!token) throw new Error('Вход в Spotify устарел — войдите заново');
        items = await fetchLikedSongs(token);
      } else {
        items = (await readSpotifyPlaylist(playlist!.id)).items;
      }
      if (items.length === 0) {
        setError('В этом списке нет треков.');
        return;
      }
      onPicked(kind === 'liked' ? 'Любимые треки из Spotify' : playlist!.name, items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 pt-4 border-t-subtle">
      <p className="text-sm text-secondary" style={{ margin: '0 0 var(--space-3)' }}>
        Или войдите в Spotify — тогда можно перенести «Любимые» и выбрать плейлист из своего списка.
      </p>

      {error && (
        <p className="text-xs text-danger" style={{ margin: '0 0 var(--space-2)' }}>{error}</p>
      )}

      {!playlists && (
        <Button variant="secondary" onClick={connect} disabled={busy} data-testid="spotify-connect-btn">
          {busy ? 'Ждём Spotify…' : 'Войти в Spotify'}
        </Button>
      )}

      {playlists && (
        <ul className="m-0 p-0 grid gap-2 list-none" style={{ maxHeight: '260px', overflowY: 'auto' }}>
          <li>
            <Button variant="secondary" onClick={() => pick('liked')} disabled={busy} data-testid="spotify-liked-btn">
              Любимые треки
            </Button>
          </li>
          {playlists.map((playlist) => (
            <li key={playlist.id}>
              <Button variant="secondary" onClick={() => pick('playlist', playlist)} disabled={busy}>
                {playlist.name} · {playlist.trackCount}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
