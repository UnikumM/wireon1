import React from 'react';
import { Home, Library, Music, Radio, Search, Sparkles } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { ICON } from '../../styles/icons';

/**
 * Главная навигация — поперёк верха окна.
 *
 * Витринное направление, которое выбрал владелец, держится на одном: самое
 * крупное на экране — сама музыка, обложка и название. Боковая панель забирала
 * под себя четверть ширины навсегда, ради восьми строк, которые нажимают раз в
 * сеанс, — и обложка в оставшемся месте выходила размером с почтовую марку.
 * Наверху те же восемь пунктов занимают одну полосу, а ширина целиком уходит
 * содержимому.
 *
 * Плейлисты сюда не переехали: их список был в подвале панели и уже живёт в
 * «Медиатеке», где ему и место. В навигации остались разделы, а не записи.
 *
 * «Избранное» и «Плейлисты» отсюда убраны: это вкладки «Медиатеки», и в
 * полосе они повторяли её же — как раньше на телефоне (`MobileNav`).
 *
 * На узком окне полоса прячется (`global.css` §19) — там навигация снизу, у
 * большого пальца.
 */

type NavViewId = 'home' | 'search' | 'wave' | 'foryou' | 'library';

/** Вкладки «Медиатеки» — пункт «Медиатека» остаётся выбранным на любой из них. */
const LIBRARY_VIEWS = new Set(['library', 'favorites', 'playlists', 'offline']);

interface NavItem {
  id: NavViewId;
  label: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  // Первым пунктом — то, с чего человек начинает: чем он занимался вчера.
  { id: 'home', label: 'Главная', icon: <Home size={ICON.md} /> },
  { id: 'search', label: 'Поиск', icon: <Search size={ICON.md} /> },
  { id: 'wave', label: 'Поток', icon: <Radio size={ICON.md} /> },
  /*
   * Единственные звёздочки, оставленные в приложении. Здесь они на своём месте:
   * это значок раздела с подборками, то есть ровно то, что иконка и означает —
   * «подобрано для вас». Тот же значок стоит у этой команды в палитре, чтобы у
   * одного раздела не было двух разных лиц.
   */
  { id: 'foryou', label: 'Для вас', icon: <Sparkles size={ICON.md} /> },
  { id: 'library', label: 'Медиатека', icon: <Library size={ICON.md} /> }
  // Настройки сюда не входят: это утилита, а не место с музыкой. Они стоят
  // рядом с аккаунтом в правой части шапки.
];

export interface TopNavProps {
  className?: string;
}

export const TopNav: React.FC<TopNavProps> = ({ className = '' }) => {
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setActivePlaylistId = useUIStore((s) => s.setActivePlaylistId);

  const handleNavClick = (viewId: NavViewId) => {
    setActivePlaylistId(null);
    setActiveView(viewId);
  };

  /*
   * Цвета покоя и выбранного состояния — в `.topnav-item` (global.css §14),
   * состояние читается из `aria-current`. Здесь их держать нельзя: инлайновое
   * объявление старше правила таблицы стилей, и наведение бы не работало.
   * Ровно на этом однажды обожглась боковая панель.
   */
  return (
    <nav
      className={`wireon-topnav${className ? ` ${className}` : ''}`}
      aria-label="Разделы"
      data-testid="app-topnav"
    >
      <button
        type="button"
        className="topnav-brand focus-ring"
        onClick={() => handleNavClick('home')}
        aria-label="Wireon Sounds — на главную"
        data-testid="topnav-brand"
      >
        {/* Парящий значок — единственное украшение в полосе разделов. */}
        <span className="animate-float" aria-hidden="true" style={{ display: 'inline-flex' }}>
          <Music size={ICON.lg} />
        </span>
        <span className="hide-on-mobile">Wireon</span>
      </button>

      <div className="topnav-items">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="topnav-item focus-ring"
            aria-current={
              activeView === item.id || (item.id === 'library' && LIBRARY_VIEWS.has(activeView))
                ? 'page'
                : undefined
            }
            // Имя на кнопке, а не только в подписи: на среднем окне подписи
            // скрываются, и без этого у пунктов не осталось бы имени вовсе.
            aria-label={item.label}
            title={item.label}
            onClick={() => handleNavClick(item.id)}
            data-testid={`nav-${item.id}`}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
};
