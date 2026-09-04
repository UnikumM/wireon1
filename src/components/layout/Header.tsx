import React, { useEffect, useState } from 'react';
import { Activity, Command, Minus, Radio, Square, X } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useGroupListenStore } from '../../store/useGroupListenStore';
import { Button } from '../common/Button';
import { UserProfile } from '../auth/UserProfile';
import { GroupListenModal } from '../modals/GroupListenModal';
import { ICON } from '../../styles/icons';

/**
 * lucide не даёт «свернуть в окно», поэтому глиф свой — но нарисован на той же
 * сетке 24 и носит класс `lucide`, чтобы толщину штриха ему задала общая рампа
 * из global.css. Иначе он бы всегда чуть-чуть отличался от соседних Minus и X.
 */
const RestoreIcon: React.FC = () => (
  <svg
    className="lucide"
    width={ICON.sm}
    height={ICON.sm}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="7" y="3" width="14" height="14" rx="2" />
    <path d="M3 7v12a2 2 0 0 0 2 2h12" />
  </svg>
);

const VIEW_TITLES: Record<string, string> = {
  search: 'Поиск',
  wave: 'Поток',
  library: 'Медиатека',
  favorites: 'Избранное',
  playlists: 'Плейлисты',
  offline: 'Офлайн',
  playlist: 'Плейлист',
  settings: 'Настройки'
};

const WINDOW_BTN_STYLE: React.CSSProperties = {
  width: 'var(--control-sm)',
  height: 'var(--control-sm)',
  borderRadius: 'var(--radius-xs)',
  color: 'var(--text-secondary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer'
};

/**
 * The main-process bridge has shipped both a bare boolean and a
 * `{ isMaximized }` payload, so the renderer never trusts the shape.
 */
function normalizeMaximized(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && 'isMaximized' in value) {
    return Boolean((value as { isMaximized?: unknown }).isMaximized);
  }
  return false;
}

export interface HeaderProps {
  className?: string;
}

export const Header: React.FC<HeaderProps> = ({ className = '' }) => {
  const activeView = useUIStore((s) => s.activeView);
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const visualizerEnabled = usePlayerStore((s) => s.visualizerEnabled);
  const toggleVisualizer = usePlayerStore((s) => s.toggleVisualizer);

  const isGroupConnected = useGroupListenStore((s) => s.isConnected);
  const groupRoomId = useGroupListenStore((s) => s.roomId);
  const groupConnectionStatus = useGroupListenStore((s) => s.connectionStatus);
  const isGroupModalOpen = useGroupListenStore((s) => s.isModalOpen);
  const setGroupModalOpen = useGroupListenStore((s) => s.setModalOpen);
  const [localModalOpen, setLocalModalOpen] = useState(false);

  // A room can exist without a broker behind it. Green means "the others hear
  // this"; amber means "so far only this computer". Both come from the state
  // tokens: a hard-coded hex here survived every theme switch untouched.
  const groupDotColor = groupConnectionStatus === 'online' ? 'var(--success)' : 'var(--warning)';
  const groupTitle =
    groupConnectionStatus === 'online'
      ? 'Слушаем вместе'
      : groupConnectionStatus === 'connecting'
        ? 'Подключаемся к комнате'
        : 'Комната только на этом устройстве';

  const [isDesktop, setIsDesktop] = useState<boolean>(
    () => typeof window !== 'undefined' && typeof window.electronAPI?.minimize === 'function'
  );
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.electronAPI?.minimize !== 'function') {
      setIsDesktop(false);
      return;
    }

    setIsDesktop(true);

    if (typeof window.electronAPI.isMaximized === 'function') {
      window.electronAPI
        .isMaximized()
        .then((maximized) => setIsMaximized(normalizeMaximized(maximized)))
        .catch(() => {});
    }

    if (typeof window.electronAPI.onWindowStateChange !== 'function') return;

    const unsubscribe = window.electronAPI.onWindowStateChange((maximized) => {
      setIsMaximized(normalizeMaximized(maximized));
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  const dragRegion: React.CSSProperties = isDesktop ? { WebkitAppRegion: 'drag' } : {};
  const noDragRegion: React.CSSProperties = isDesktop ? { WebkitAppRegion: 'no-drag' } : {};

  return (
    <header
      className={`wireon-header${className ? ` ${className}` : ''}`}
      style={
        {
          // Высота растёт на вырез: на телефоне часы и значки связи рисуются
          // поверх страницы, и без этого заголовок с кнопками оказывается
          // ровно под ними. На десктопе `--safe-top` равен нулю.
          height: 'calc(var(--header-height) + var(--safe-top))',
          paddingTop: 'var(--safe-top)',
          paddingLeft: 'calc(var(--header-pad-x) + var(--safe-left))',
          paddingRight: 'calc(var(--header-pad-x) + var(--safe-right))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-3)',
          backgroundColor: 'var(--surface-1)',
          borderBottom: '1px solid var(--border-subtle)',
          userSelect: 'none',
          flexShrink: 0,
          zIndex: 'var(--z-header)',
          ...dragRegion
        } as React.CSSProperties
      }
      data-testid="app-header"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0, ...noDragRegion }}>
        <h2
          className="text-truncate"
          style={{
            margin: 0,
            fontSize: 'var(--text-lg)',
            lineHeight: 'var(--leading-lg)',
            letterSpacing: 'var(--tracking-lg)',
            fontWeight: 'var(--weight-semibold)',
            color: 'var(--text-primary)'
          }}
        >
          {VIEW_TITLES[activeView] ?? 'Wireon Sounds'}
        </h2>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', ...noDragRegion }}>
        {/*
          * Палитра команд убрана с узкого экрана целиком, а не сжата до значка.
          * Это единственная кнопка в шапке, которая ничего не делает сама: она
          * показывает список сочетаний клавиш, а клавиатуры на телефоне нет.
          * Подпись «Ctrl K» рядом с ней там читалась прямой неправдой.
          */}
        <div className="hide-on-mobile">
          <Button
            variant="subtle"
            size="sm"
            onClick={toggleCommandPalette}
            icon={<Command size={ICON.sm} />}
            title="Палитра команд"
            aria-label="Открыть палитру команд"
            data-testid="header-command-palette-btn"
          >
            <span>Команды</span>
            <kbd className="kbd" style={{ marginLeft: 'var(--space-2)' }}>
              Ctrl K
            </kbd>
          </Button>
        </div>

        <Button
          variant={visualizerEnabled ? 'secondary' : 'ghost'}
          size="sm"
          isActive={visualizerEnabled}
          onClick={toggleVisualizer}
          icon={<Activity size={ICON.sm} />}
          title={visualizerEnabled ? 'Визуализация включена' : 'Визуализация выключена'}
          aria-label="Визуализация"
          aria-pressed={visualizerEnabled}
          data-testid="header-visualizer-toggle"
        >
          {/*
            * Подпись прячется, значок остаётся: на 360 px две подписанные
            * кнопки съедают всю строку, и заголовок раздела вытесняется за
            * край. Значок с `title` и `aria-label` доносит то же самое.
            */}
          <span className="hide-on-mobile">Визуализация</span>
        </Button>

        {/*
          * Кнопки «Очередь» здесь больше нет.
          *
          * Она открывала ту же панель, что кнопка в полосе плеера, тем же вызовом
          * `toggleQueue`, тем же значком и с таким же счётчиком — два одинаковых
          * органа управления в одном окне, на расстоянии высоты экрана друг от друга.
          * Очередь — это про воспроизведение, поэтому она осталась там, где стоит
          * транспорт: рядом с ней и видно, что именно играет сейчас. Тем, кто ходит
          * с клавиатуры, очередь по-прежнему доступна из палитры команд, а кому
          * кнопка в полосе не нужна вовсе — модуль «queue» выключается в настройках
          * плеера.
          */}
        <Button
          variant={isGroupConnected ? 'secondary' : 'ghost'}
          size="sm"
          isActive={isGroupConnected}
          onClick={() => setLocalModalOpen(true)}
          icon={<Radio size={ICON.sm} style={isGroupConnected ? { color: groupDotColor } : undefined} />}
          title={isGroupConnected ? `${groupTitle} (${groupRoomId})` : 'Слушать вместе'}
          aria-label="Слушать вместе — комнаты синхронизации"
          aria-pressed={isGroupConnected}
          data-testid="header-group-listen-btn"
        >
          <span className="hide-on-mobile">Вместе</span>
          {isGroupConnected && (
            <span
              style={{
                marginLeft: 'var(--space-1)',
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                backgroundColor: groupDotColor,
                // Only a real broker connection gets the glow; anything else is
                // amber, so the header never claims a sync that is not happening.
                boxShadow: groupConnectionStatus === 'online' ? `0 0 6px ${groupDotColor}` : 'none',
                display: 'inline-block'
              }}
              data-testid="header-group-listen-pulse"
            />
          )}
        </Button>

        {/*
          * Вход в аккаунт здесь — только на узком окне.
          *
          * Пока боковая панель на месте, пилюля профиля стоит у неё в подвале, и
          * такая же пилюля в шапке была ровно тем же элементом второй раз на том же
          * экране: тот же аватар, то же имя, то же меню. Мало того, у обеих копий
          * совпадали `data-testid`, то есть в документе жили два элемента с одним
          * именем. Хуже места для неё тоже не придумать: справа от неё системные
          * кнопки окна, и промах по «закрыть» стоит дороже, чем лишний ход мышью.
          *
          * На узком окне панель уезжает вместе со своим подвалом (global.css §20),
          * поэтому вход обязан остаться здесь — им и распоряжается `.show-on-mobile`.
          * `display` подставляется переменной: у обёртки он `flex`, иначе пилюля
          * потеряет выравнивание по центру строки.
          */}
        <div
          className="show-on-mobile"
          style={{ '--show-on-mobile-display': 'flex', alignItems: 'center' } as React.CSSProperties}
          data-testid="header-user-profile"
        >
          <UserProfile />
        </div>

        {isDesktop && (
          <div
            className="window-controls"
            data-testid="window-controls"
            style={
              {
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-1)',
                marginLeft: 'var(--space-2)',
                paddingLeft: 'var(--space-3)',
                borderLeft: '1px solid var(--border-subtle)',
                ...noDragRegion
              } as React.CSSProperties
            }
          >
            <button
              type="button"
              onClick={() => window.electronAPI?.minimize?.()}
              title="Свернуть"
              aria-label="Свернуть окно"
              data-testid="window-minimize-btn"
              className="window-btn minimize-btn press"
              style={WINDOW_BTN_STYLE}
            >
              <Minus size={ICON.sm} aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={() => window.electronAPI?.maximize?.()}
              title={isMaximized ? 'Свернуть в окно' : 'Развернуть'}
              aria-label={isMaximized ? 'Свернуть в окно' : 'Развернуть окно'}
              data-testid="window-maximize-btn"
              className="window-btn maximize-btn press"
              style={WINDOW_BTN_STYLE}
            >
              {isMaximized ? <RestoreIcon /> : <Square size={ICON.sm} aria-hidden="true" />}
            </button>

            {/* Overriding --surface-hover is what turns `.press`'s neutral hover
                red here, so the destructive tint needs no inline event handler. */}
            <button
              type="button"
              onClick={() => window.electronAPI?.close?.()}
              title="Закрыть"
              aria-label="Закрыть окно"
              data-testid="window-close-btn"
              className="window-btn close-btn press"
              style={{ ...WINDOW_BTN_STYLE, '--surface-hover': 'var(--danger-soft)' } as React.CSSProperties}
            >
              <X size={ICON.sm} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <GroupListenModal
        isOpen={localModalOpen || isGroupModalOpen}
        onClose={() => {
          setLocalModalOpen(false);
          setGroupModalOpen(false);
        }}
      />
    </header>
  );
};
