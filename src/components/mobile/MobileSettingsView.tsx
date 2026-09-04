import React, { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Info,
  Keyboard,
  ListMusic,
  Palette,
  Sliders,
  SlidersHorizontal,
  Stethoscope,
  User,
  Volume2
} from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { PlaybackSettings } from '../settings/PlaybackSettings';
import { PlayerLayoutSettings } from '../settings/PlayerLayoutSettings';
import { AppearanceSettings } from '../settings/AppearanceSettings';
import { DesignSettings } from '../settings/DesignSettings';
import { LibrarySettings } from '../settings/LibrarySettings';
import { OfflineSettings } from '../settings/OfflineSettings';
import { AccountSettings } from '../settings/AccountSettings';
import { DesktopSettings } from '../settings/DesktopSettings';
import { DiagnosticsSettings } from '../settings/DiagnosticsSettings';
import { ShortcutsSettings } from '../settings/ShortcutsSettings';
import { AboutSettings } from '../settings/AboutSettings';
import { ICON } from '../../styles/icons';

/**
 * Настройки на телефоне: список разделов, а не полоса плашек.
 *
 * Было так. Девять плашек-пилюль не помещались в 328 px и переносились в
 * **четыре ряда**, занимая 400 px из 800 — половину экрана до первой настройки.
 * При этом плашки не переключали разделы, а прокручивали к ним: все девять
 * разделов лежали в одной длинной ленте, и до «О программе» надо было
 * пролистать всё остальное.
 *
 * Стало так, как это устроено в настройках самого телефона: список разделов, и
 * раздел открывается своей страницей с возвратом. Каждый раздел — тот же
 * компонент, что и на ПК; переписан только способ до них добираться.
 */

/*
 * Те же две проверки, что и в настольном экране. Своя копия здесь честнее
 * общего помощника: на телефоне обе всегда ложны, и раздел просто не
 * появляется — в отличие от прежнего поведения, где плашка была, а панель за
 * ней пустовала.
 */
function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.setMediaKeysEnabled === 'function';
}

function hasDiagnosticsBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.getStreamDiagnostics === 'function';
}

interface SectionEntry {
  id: string;
  label: string;
  hint: string;
  icon: React.ReactNode;
  render: () => React.ReactNode;
}

export const MobileSettingsView: React.FC = () => {
  const setActiveView = useUIStore((s) => s.setActiveView);
  const [openId, setOpenId] = useState<string | null>(null);

  const sections = useMemo<SectionEntry[]>(() => {
    const entries: SectionEntry[] = [
      {
        id: 'playback',
        label: 'Воспроизведение',
        hint: 'Громкость, тембр, переходы',
        icon: <Volume2 size={ICON.lg} />,
        render: () => <PlaybackSettings />
      },
      {
        id: 'player',
        label: 'Плеер',
        hint: 'Что показывать в плеере',
        icon: <SlidersHorizontal size={ICON.lg} />,
        render: () => <PlayerLayoutSettings />
      },
      {
        id: 'appearance',
        label: 'Внешний вид',
        hint: 'Тема и акцент',
        icon: <Palette size={ICON.lg} />,
        render: () => <AppearanceSettings />
      },
      {
        id: 'design',
        label: 'Оформление',
        hint: 'Пресеты, шрифт, плотность',
        icon: <Sliders size={ICON.lg} />,
        render: () => <DesignSettings />
      },
      {
        id: 'library',
        label: 'Медиатека',
        hint: 'История и синхронизация',
        icon: <ListMusic size={ICON.lg} />,
        render: () => <LibrarySettings />
      },
      {
        id: 'offline',
        label: 'Офлайн',
        hint: 'Что хранится на устройстве',
        icon: <Download size={ICON.lg} />,
        render: () => <OfflineSettings />
      },
      {
        id: 'account',
        label: 'Аккаунт',
        hint: 'Вход через Discord',
        icon: <User size={ICON.lg} />,
        render: () => <AccountSettings />
      }
    ];
    // Разделы без моста на телефоне ничего не рисуют — и строки им не нужно.
    if (hasDesktopBridge()) {
      entries.push({
        id: 'desktop',
        label: 'Приложение',
        hint: 'Окно, горячие клавиши системы',
        icon: <SlidersHorizontal size={ICON.lg} />,
        render: () => <DesktopSettings />
      });
    }
    if (hasDiagnosticsBridge()) {
      entries.push({
        id: 'diagnostics',
        label: 'Диагностика',
        hint: 'Что происходит под капотом',
        icon: <Stethoscope size={ICON.lg} />,
        render: () => <DiagnosticsSettings />
      });
    }
    entries.push({
      id: 'shortcuts',
      label: 'Горячие клавиши',
      hint: 'Список сочетаний',
      icon: <Keyboard size={ICON.lg} />,
      render: () => <ShortcutsSettings />
    });
    entries.push({
      id: 'about',
      label: 'О программе',
      hint: 'Версия и обновления',
      icon: <Info size={ICON.lg} />,
      render: () => <AboutSettings />
    });
    return entries;
  }, []);

  const open = sections.find((section) => section.id === openId) ?? null;

  if (open) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }} data-testid="mobile-settings-section">
        {/*
          * Заголовка здесь нет намеренно: раздел называет себя сам — каждый из
          * них обёрнут в `SettingsSection`, а та рисует свой `h2` с описанием.
          * Собственный заголовок страницы дал бы «Воспроизведение» дважды
          * подряд, одно под другим.
          */}
        <header style={{ display: 'flex', alignItems: 'center' }}>
          <BackButton onClick={() => setOpenId(null)} testId="mobile-settings-back" />
        </header>
        {open.render()}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }} data-testid="mobile-settings">
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <BackButton onClick={() => setActiveView('home')} testId="mobile-settings-home" />
        <h1
          style={{
            margin: 0,
            minWidth: 0,
            fontSize: 'var(--text-2xl)',
            lineHeight: 'var(--leading-2xl)',
            letterSpacing: 'var(--tracking-2xl)',
            fontWeight: 'var(--weight-bold)',
            color: 'var(--text-primary)'
          }}
        >
          Настройки
        </h1>
      </header>

      <div
        style={{
          borderRadius: 'var(--radius-lg)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden'
        }}
      >
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            className="menu-item-hover press"
            onClick={() => setOpenId(section.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-4)',
              width: '100%',
              minHeight: '56px',
              padding: 'var(--space-2) var(--space-4)',
              textAlign: 'left',
              color: 'var(--text-primary)',
              cursor: 'pointer'
            }}
            data-testid={`mobile-settings-row-${section.id}`}
          >
            <span style={{ display: 'flex', flexShrink: 0, color: 'var(--text-secondary)' }}>{section.icon}</span>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: '2px' }}>
              <span
                className="text-truncate"
                style={{
                  fontSize: 'var(--text-base)',
                  lineHeight: 'var(--leading-base)',
                  letterSpacing: 'var(--tracking-base)'
                }}
              >
                {section.label}
              </span>
              <span
                className="text-truncate"
                style={{
                  fontSize: 'var(--text-sm)',
                  lineHeight: 'var(--leading-sm)',
                  letterSpacing: 'var(--tracking-sm)',
                  color: 'var(--text-muted)'
                }}
              >
                {section.hint}
              </span>
            </span>
            <ChevronRight size={ICON.md} style={{ flexShrink: 0, color: 'var(--text-faint)' }} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
};

const BackButton: React.FC<{ onClick: () => void; testId: string }> = ({ onClick, testId }) => (
  <button
    type="button"
    className="press focus-ring"
    onClick={onClick}
    aria-label="Назад"
    style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '44px',
      height: '44px',
      flexShrink: 0,
      marginLeft: 'calc(var(--space-3) * -1)',
      borderRadius: 'var(--radius-pill)',
      color: 'var(--text-secondary)',
      cursor: 'pointer'
    }}
    data-testid={testId}
  >
    <ChevronLeft size={ICON.xl} aria-hidden="true" />
  </button>
);
