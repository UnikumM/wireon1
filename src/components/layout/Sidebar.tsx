import React from 'react';
import { Search, Library, Heart, ListMusic, Plus, Music, Settings, Disc3, Radio, Sparkles } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { useLibraryStore } from '../../store/useLibraryStore';
import { Button } from '../common/Button';
import { UserProfile } from '../auth/UserProfile';
import { ICON } from '../../styles/icons';

type NavViewId = 'search' | 'wave' | 'foryou' | 'library' | 'favorites' | 'playlists' | 'settings';

interface NavItem {
  id: NavViewId;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'search', label: 'Поиск', icon: <Search size={ICON.lg} /> },
  { id: 'wave', label: 'Поток', icon: <Radio size={ICON.lg} /> },
  /*
   * Единственные звёздочки, оставленные в приложении. Здесь они на своём месте:
   * это значок раздела с подборками, то есть ровно то, что иконка и означает —
   * «подобрано для вас». Тот же значок стоит у этой команды в палитре, чтобы у
   * одного раздела не было двух разных лиц. Во всех прочих местах звёздочки
   * заменены на значки по смыслу: они там означали «что-то приятное вообще».
   */
  { id: 'foryou', label: 'Для вас', icon: <Sparkles size={ICON.lg} /> },
  { id: 'library', label: 'Медиатека', icon: <Library size={ICON.lg} /> },
  { id: 'favorites', label: 'Избранное', icon: <Heart size={ICON.lg} /> },
  { id: 'playlists', label: 'Плейлисты', icon: <ListMusic size={ICON.lg} /> },
  { id: 'settings', label: 'Настройки', icon: <Settings size={ICON.lg} /> }
];

export interface SidebarProps {
  onCreatePlaylistClick?: () => void;
  className?: string;
}

/**
 * Primary navigation. Active rows are marked by an accent rail, a weight change
 * and `aria-current`, never by colour alone.
 */
export const Sidebar: React.FC<SidebarProps> = ({ onCreatePlaylistClick, className = '' }) => {
  const activeView = useUIStore((s) => s.activeView);
  const activePlaylistId = useUIStore((s) => s.activePlaylistId);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setActivePlaylistId = useUIStore((s) => s.setActivePlaylistId);
  const playlists = useLibraryStore((s) => s.playlists);

  const handleNavClick = (viewId: NavViewId) => {
    setActivePlaylistId(null);
    setActiveView(viewId);
  };

  const handlePlaylistClick = (playlistId: string) => {
    setActivePlaylistId(playlistId);
    setActiveView('playlist');
  };

  /*
   * Цвета покоя и выбранного состояния — в `.sidebar-nav-item` /
   * `.sidebar-playlist-item` (global.css §14), состояние читается из
   * `aria-current`. Здесь их держать нельзя: инлайновое объявление старше
   * правила таблицы стилей, поэтому оба класса висели на разметке мёртвыми, а
   * навигация — главный список приложения — не отвечала на наведение вообще.
   */
  const rowStyle = (isActive: boolean): React.CSSProperties => ({
    gap: 'var(--space-3)',
    padding: 'var(--space-2) var(--space-3)',
    fontWeight: isActive ? 'var(--weight-semibold)' : 'var(--weight-medium)'
  });

  return (
    <aside
      className={`wireon-sidebar${className ? ` ${className}` : ''}`}
      style={
        {
          // Ширины и `display` здесь нет: на узком окне панель скрывается
          // брейкпоинтом (global.css §19), а инлайновое `display: flex` он бы
          // перебить не смог — инлайн старше правила таблицы. По той же причине
          // ширина тоже переехала в класс.
          height: '100%',
          /*
           * Снизу — место под полосу плеера, и это не отступ ради воздуха.
           *
           * Полоса лежит `position: fixed` во всю ширину окна, то есть
           * **поверх боковой панели тоже**. У `<main>` место под неё
           * зарезервировано с самого начала (`AppShell.tsx`), а у панели не
           * было — и её нижний ряд, пилюля аккаунта, оказывался целиком под
           * полосой: замерено 821–876 px при полосе от 804 px. Кнопка была на
           * месте, отзывалась на клавиатуру, но мышь до неё не доставала
           * вовсе — `elementFromPoint` в её середине возвращает полосу.
           */
          padding:
            'var(--space-5) var(--space-3) calc(var(--player-bar-space) + var(--space-3))',
          backgroundColor: 'var(--surface-1)',
          borderRight: '1px solid var(--border-subtle)',
          userSelect: 'none',
          flexShrink: 0,
          zIndex: 'var(--z-sticky)'
        } as React.CSSProperties
      }
      data-testid="app-sidebar"
    >
      <button
        type="button"
        onClick={() => handleNavClick('search')}
        aria-label="Wireon Sounds — на главную"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-1) var(--space-2) var(--space-5)',
          cursor: 'pointer',
          textAlign: 'left'
        }}
        data-testid="sidebar-brand"
      >
        <span
          className="animate-float"
          style={{
            width: '32px',
            height: '32px',
            borderRadius: 'var(--radius-md)',
            backgroundColor: 'var(--surface-3)',
            border: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            color: 'var(--accent)'
          }}
        >
          <Disc3 size={ICON.lg} aria-hidden="true" />
        </span>
        <span
          style={{
            fontSize: 'var(--text-lg)',
            lineHeight: 'var(--leading-lg)',
            letterSpacing: 'var(--tracking-lg)',
            fontWeight: 'var(--weight-semibold)',
            color: 'var(--text-primary)',
            // Название не переносится: в панель на 260px «Wireon Sounds»
            // укладывается в строку, а перенос разорвал бы его надвое.
            whiteSpace: 'nowrap'
          }}
        >
          {/* Одна надпись одним цветом. Раньше здесь было «Wire» + приглушённое
              «on», и название читалось как два слова. У «Sounds» чуть тоньше
              начертание — этого достаточно для второго плана, а цвет общий,
              поэтому отдельным серым куском оно не выглядит. */}
          Wireon <span style={{ fontWeight: 'var(--weight-medium)' }}>Sounds</span>
        </span>
      </button>

      <nav
        aria-label="Основная навигация"
        style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: 'var(--space-6)' }}
      >
        {NAV_ITEMS.map((item) => {
          const isActive = activeView === item.id && activePlaylistId === null;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleNavClick(item.id)}
              aria-current={isActive ? 'page' : undefined}
              style={{ ...rowStyle(isActive), fontSize: 'var(--text-sm)' }}
              className="sidebar-nav-item"
              data-testid={`sidebar-nav-${item.id}`}
            >
              <span style={{ display: 'inline-flex', color: isActive ? 'var(--accent)' : 'var(--text-muted)' }}>
                {item.icon}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 var(--space-2) var(--space-2)',
            borderBottom: '1px solid var(--border-subtle)',
            marginBottom: 'var(--space-2)'
          }}
        >
          <span className="section-label">Плейлисты</span>
          {onCreatePlaylistClick && (
            <Button
              variant="icon"
              size="xs"
              onClick={onCreatePlaylistClick}
              title="Создать плейлист"
              aria-label="Создать плейлист"
              style={{ width: 'var(--control-sm)', height: 'var(--control-sm)' }}
              data-testid="sidebar-create-playlist-btn"
            >
              <Plus size={ICON.sm} />
            </Button>
          )}
        </div>

        <div
          className="scrollbar-thin"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}
        >
          {playlists.length === 0 ? (
            <p
              style={{
                margin: 0,
                padding: 'var(--space-4) var(--space-2)',
                fontSize: 'var(--text-xs)',
                lineHeight: 'var(--leading-xs)',
                color: 'var(--text-muted)'
              }}
            >
              Плейлистов пока нет.
            </p>
          ) : (
            playlists.map((playlist) => {
              const isActive = activeView === 'playlist' && activePlaylistId === playlist.id;
              return (
                <button
                  key={playlist.id}
                  type="button"
                  onClick={() => handlePlaylistClick(playlist.id)}
                  aria-current={isActive ? 'page' : undefined}
                  style={{ ...rowStyle(isActive), fontSize: 'var(--text-sm)', gap: 'var(--space-2)' }}
                  className="sidebar-playlist-item"
                  title={playlist.title}
                  data-testid={`sidebar-playlist-${playlist.id}`}
                >
                      <Music size={ICON.sm} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--text-faint)' }} />
                  <span className="text-truncate" style={{ flex: 1, minWidth: 0 }}>
                    {playlist.title}
                  </span>
                  <span data-numeric style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    {playlist.tracks.length}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div
        style={{
          marginTop: 'auto',
          paddingTop: 'var(--space-3)',
          borderTop: '1px solid var(--border-subtle)',
          display: 'flex',
          justifyContent: 'center'
        }}
        data-testid="sidebar-user-section"
      >
        {/*
          * Вверх, а не вниз: пилюля стоит у нижнего края окна, и меню,
          * открытое вниз, уезжало за экран целиком.
          */}
        <UserProfile style={{ width: '100%' }} placement="up" align="left" />
      </div>
    </aside>
  );
};
