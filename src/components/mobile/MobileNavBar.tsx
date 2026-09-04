import React from 'react';
import { Home, Search, ListMusic } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { ICON } from '../../styles/icons';

/**
 * Нижняя панель телефона: Главная, Поиск, Медиатека.
 *
 * Что изменилось против прежних трёх вкладок (Поиск / Поток / Медиатека).
 *
 * **Появилась Главная.** Приложение открывалось на поиске — пустом поле с
 * плашками жанров и полуэкраном пустоты под ними. Человеку, который просто
 * хочет включить музыку, предлагали сначала придумать, что искать. Теперь
 * первое, что он видит, — то, что уже слушал.
 *
 * **Поток ушёл с панели, но не из приложения.** Он занимал целую вкладку ради
 * одной кнопки «Запустить». На Главной он стал карточкой во всю ширину — то же
 * одно нажатие, но без отдельного этажа навигации.
 *
 * **У кнопок появились имена.** В прежней панели подпись была нарисована
 * текстом рядом с иконкой, но `aria-label` не было ни у одной кнопки: программе
 * чтения с экрана они представлялись просто «кнопка».
 */

type MobileTabId = 'home' | 'search' | 'library';

interface MobileTab {
  id: MobileTabId;
  label: string;
  icon: React.ReactNode;
}

const TABS: MobileTab[] = [
  { id: 'home', label: 'Главная', icon: <Home size={ICON.lg} /> },
  { id: 'search', label: 'Поиск', icon: <Search size={ICON.lg} /> },
  { id: 'library', label: 'Медиатека', icon: <ListMusic size={ICON.lg} /> }
];

/** Какая вкладка считается выбранной для каждого маршрута. */
const TAB_FOR_VIEW: Record<string, MobileTabId> = {
  home: 'home',
  foryou: 'home',
  wave: 'home',
  search: 'search',
  artist: 'search',
  library: 'library',
  favorites: 'library',
  playlists: 'library',
  offline: 'library',
  playlist: 'library'
};

export const MobileNavBar: React.FC = () => {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setActivePlaylistId = useUIStore((s) => s.setActivePlaylistId);

  const activeTab = TAB_FOR_VIEW[activeView];

  const handleTabClick = (tabId: MobileTabId) => {
    setActivePlaylistId(null);
    setActiveView(tabId);
  };

  return (
    <nav
      aria-label="Основная навигация"
      style={{
        display: 'flex',
        flexShrink: 0,
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--surface-1)',
        /*
         * Не голый `--safe-bottom`, а он же с полом.
         *
         * На эмуляторе с жестовой навигацией Android сообщает нижний отступ
         * нулём, хотя полоса жестов рисуется поверх окна: подписи вкладок
         * оказывались ровно под ней. Пол в 8 px разводит их в любом случае, а
         * там, где система отступ всё-таки называет, побеждает он.
         */
        paddingBottom: 'max(var(--safe-bottom), var(--space-2))'
      }}
      data-testid="mobile-nav"
    >
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleTabClick(tab.id)}
            aria-label={tab.label}
            aria-current={isActive ? 'page' : undefined}
            style={{
              display: 'flex',
              flex: 1,
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'var(--space-1)',
              // 56 — минимум, при котором в кнопку попадают, не глядя на экран.
              minHeight: '56px',
              padding: 'var(--space-2) var(--space-1)',
              border: 'none',
              background: 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-faint)',
              cursor: 'pointer'
            }}
            data-testid={`mobile-nav-${tab.id}`}
          >
            {tab.icon}
            <span
              style={{
                fontSize: 'var(--text-xs)',
                lineHeight: 'var(--leading-xs)',
                letterSpacing: 'var(--tracking-xs)',
                fontWeight: isActive ? 'var(--weight-semibold)' : 'var(--weight-normal)'
              }}
            >
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
};
