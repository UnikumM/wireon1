import React from 'react';
import { Search, Library, Radio } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { ICON } from '../../styles/icons';

type MobileTabId = 'search' | 'wave' | 'library';

interface MobileTab {
  id: MobileTabId;
  label: string;
  icon: React.ReactNode;
}

/**
 * Три раздела, а не шесть.
 *
 * Шесть подписей делили ширину экрана поровну, и на 375 px каждой доставалось
 * 62 px — «Настройки» в это не влезали. Но ужимать было нечего: половина этих
 * разделов дублировала сама себя. «Избранное» и «Плейлисты» — это **вкладки
 * внутри Медиатеки** (`LibraryView`), то есть один и тот же экран был в панели
 * трижды. DESIGN_SYSTEM §15 про это прямо: два органа управления с одним
 * действием — не запас, а две вещи, которые надо держать в согласии.
 *
 * Настройки ушли под аватар в шапке — туда же, куда их кладут телефонные
 * приложения, и там они рядом с аккаунтом, к которому и относятся.
 */
const TABS: MobileTab[] = [
  { id: 'search', label: 'Поиск', icon: <Search size={ICON.lg} /> },
  { id: 'wave', label: 'Поток', icon: <Radio size={ICON.lg} /> },
  { id: 'library', label: 'Медиатека', icon: <Library size={ICON.lg} /> }
];

export interface MobileNavProps {
  className?: string;
}

/**
 * Narrow-viewport twin of the sidebar — the same five destinations, so the two
 * can never drift. Visibility is driven by the responsive rules in `global.css`
 * (§16): the class is hidden by default and revealed at `max-width: 768px`.
 */
export const MobileNav: React.FC<MobileNavProps> = ({ className = '' }) => {
  const activeView = useUIStore((s) => s.activeView);
  const activePlaylistId = useUIStore((s) => s.activePlaylistId);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const setActivePlaylistId = useUIStore((s) => s.setActivePlaylistId);

  const handleTabClick = (tabId: MobileTabId) => {
    setActivePlaylistId(null);
    setActiveView(tabId);
  };

  return (
    <nav
      className={`wireon-mobile-nav${className ? ` ${className}` : ''}`}
      aria-label="Основная навигация"
      style={
        {
          // `display` здесь нет намеренно: и «нет панели», и «есть панель»
          // живут в `.wireon-mobile-nav` (global.css §19). Инлайновое
          // `display: none` стояло тут с комментарием «раскрывается
          // брейкпоинтом» — а раскрыть его брейкпоинт не может, инлайн старше
          // любого правила таблицы. Панель не показывалась ни при какой ширине.
          width: '100%',
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          // minHeight, а не height: снизу добавляется `safe-area-inset-bottom`,
          // и при box-sizing: border-box фиксированная высота съела бы её из
          // содержимого — кнопки в 56 px вылезли бы за панель.
          minHeight: 'var(--mobile-nav-height)',
          backgroundColor: 'var(--surface-2)',
          borderTop: '1px solid var(--border-subtle)',
          zIndex: 'var(--z-drawer)',
          alignItems: 'stretch',
          justifyContent: 'space-around',
          padding: '0 var(--space-1)',
          // Через переменную, а не `env()` напрямую: полоса плеера считает
          // своё место по `--safe-bottom`, и два разных источника одного и того
          // же значения рано или поздно разойдутся — между панелями появится
          // щель или нахлёст, и найти причину будет негде.
          paddingBottom: 'var(--safe-bottom)'
        } as React.CSSProperties
      }
      data-testid="mobile-nav"
    >
      {TABS.map((tab) => {
        const isActive = activeView === tab.id && activePlaylistId === null;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleTabClick(tab.id)}
            aria-current={isActive ? 'page' : undefined}
            className="press"
            style={{
              position: 'relative',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              // Минус рамка сверху: `--mobile-nav-height` — это вся панель
              // целиком, по ней полоса плеера считает, куда ей встать. Кнопка
              // в полную высоту делала панель на пиксель выше, и полоса
              // наезжала на её верхнюю черту, съедая границу между ними.
              minHeight: 'calc(var(--mobile-nav-height) - 1px)',
              padding: 'var(--space-2) var(--space-1)',
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-xs)',
              fontWeight: isActive ? 'var(--weight-semibold)' : 'var(--weight-medium)',
              cursor: 'pointer'
            }}
            data-testid={`mobile-nav-${tab.id}`}
          >
            {isActive && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: '20px',
                  height: '2px',
                  borderRadius: 'var(--radius-full)',
                  backgroundColor: 'var(--accent)'
                }}
              />
            )}
            <span style={{ display: 'inline-flex', color: isActive ? 'var(--accent)' : 'inherit' }}>{tab.icon}</span>
            {/* Обрезание оставлено на будущее: разделов три и места хватает
                с запасом, но длинное слово не должно вылезать за свою кнопку.
                Обрезается сама подпись, а не кнопка: кнопка — колонка, и текст
                из неё вылез бы мимо её `overflow`. */}
            <span
              style={{
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
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
