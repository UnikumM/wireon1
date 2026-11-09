import React from 'react';
import { Home, Library, Pin, Radio, Search, Settings, Sparkles } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { usePinnedStore } from '../../store/usePinnedStore';
import { useAppLayoutStore, type LayoutTab } from '../../store/useAppLayoutStore';
import { ICON } from '../../styles/icons';
import { PlaylistCover } from '../library/PlaylistCover';

/**
 * Рейка — навигация ПК в 4.0.
 *
 * Разделы слева, а не в шапке: в концепте «Сцена» верх окна отдан поиску и
 * воздуху, а слева в одну колонку помещаются и разделы, и закреплённые
 * плейлисты, до которых раньше нужно было идти через «Медиатеку». Ширина
 * колонки берётся из настройки раскладки; на среднем окне подписи уходят и
 * остаётся колонка значков (appLayout.css), так что обложке в содержимом
 * по-прежнему достаётся почти вся ширина — аргумент, из-за которого разделы
 * когда-то переехали наверх, учтён.
 *
 * Пункты — те же, что в `TopNav`, и в том же порядке из настроек раскладки:
 * верхняя полоса осталась выбором, и человек, переключаясь между ними, видит
 * одни и те же разделы.
 */

const LIBRARY_VIEWS = new Set(['library', 'favorites', 'playlists', 'offline', 'smart']);

const SECTIONS: Record<LayoutTab, { label: string; icon: React.ReactNode }> = {
  home: { label: 'Главная', icon: <Home size={ICON.md} /> },
  search: { label: 'Поиск', icon: <Search size={ICON.md} /> },
  wave: { label: 'Поток', icon: <Radio size={ICON.md} /> },
  foryou: { label: 'Для вас', icon: <Sparkles size={ICON.md} /> },
  library: { label: 'Медиатека', icon: <Library size={ICON.md} /> }
};

export const Rail: React.FC = () => {
  const activeView = useUIStore((s) => s.activeView);
  const activePlaylistId = useUIStore((s) => s.activePlaylistId);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setActivePlaylistId = useUIStore((s) => s.setActivePlaylistId);
  const layout = useAppLayoutStore((s) => s.desktop);
  const playlists = useLibraryStore((s) => s.playlists);
  const pinnedIds = usePinnedStore((s) => s.pinnedIds);

  const items = layout.tabs.filter((id) => !layout.hiddenTabs.includes(id));
  // Порядок — как закрепляли: закреплённое наверху живёт в том порядке, в каком
  // его туда положили, а не в порядке создания плейлистов.
  const pinned = pinnedIds
    .map((id) => playlists.find((playlist) => playlist.id === id))
    .filter((playlist): playlist is NonNullable<typeof playlist> => Boolean(playlist));

  const openSection = (id: LayoutTab) => {
    setActivePlaylistId(null);
    setActiveView(id);
  };

  const openPlaylist = (id: string) => {
    setActivePlaylistId(id);
    setActiveView('playlist');
  };

  const isCurrent = (id: LayoutTab) =>
    activeView === id || (id === 'library' && LIBRARY_VIEWS.has(activeView));

  return (
    <nav className="wireon-rail" aria-label="Разделы" data-testid="app-rail">
      <button
        type="button"
        className="rail-brand focus-ring"
        onClick={() => openSection('home')}
        aria-label="Wireon Sounds — на главную"
        data-testid="rail-brand"
      >
        <img
          className="topnav-brand-mark"
          src={`${import.meta.env.BASE_URL}brand-mark.png`}
          width={ICON.lg}
          height={ICON.lg}
          alt=""
          draggable={false}
        />
        <span className="rail-label">Wireon</span>
      </button>

      <div className="rail-group" role="list">
        {items.map((id) => (
          <button
            key={id}
            type="button"
            role="listitem"
            className="rail-item focus-ring"
            aria-current={isCurrent(id) ? 'page' : undefined}
            aria-label={SECTIONS[id].label}
            title={SECTIONS[id].label}
            onClick={() => openSection(id)}
            data-testid={`nav-${id}`}
          >
            <span className="rail-icon" aria-hidden="true">{SECTIONS[id].icon}</span>
            <span className="rail-label">{SECTIONS[id].label}</span>
          </button>
        ))}
      </div>

      {pinned.length > 0 && (
        <div className="rail-group rail-pinned" data-testid="rail-pinned">
          <div className="rail-caption rail-label">
            <Pin size={ICON.xs} aria-hidden="true" />
            Закреплено
          </div>
          {pinned.map((playlist) => (
            <button
              key={playlist.id}
              type="button"
              className="rail-item rail-playlist focus-ring"
              aria-current={activeView === 'playlist' && activePlaylistId === playlist.id ? 'page' : undefined}
              aria-label={`Плейлист «${playlist.title}»`}
              title={playlist.title}
              onClick={() => openPlaylist(playlist.id)}
              data-testid={`rail-playlist-${playlist.id}`}
            >
              <span className="rail-icon" aria-hidden="true">
                <PlaylistCover tracks={playlist.tracks} coverUrl={playlist.coverUrl} size={22} radius="var(--radius-xs)" />
              </span>
              <span className="rail-label text-truncate">{playlist.title}</span>
            </button>
          ))}
        </div>
      )}

      {/* Настройки внизу, отдельно от разделов: это утилита, а не место с музыкой. */}
      <div className="rail-foot">
        <button
          type="button"
          className="rail-item focus-ring"
          aria-current={activeView === 'settings' ? 'page' : undefined}
          aria-label="Настройки"
          title="Настройки"
          onClick={() => openSection('settings' as LayoutTab)}
          data-testid="rail-settings"
        >
          <span className="rail-icon" aria-hidden="true"><Settings size={ICON.md} /></span>
          <span className="rail-label">Настройки</span>
        </button>
      </div>
    </nav>
  );
};
