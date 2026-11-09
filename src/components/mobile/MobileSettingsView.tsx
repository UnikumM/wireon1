import React, { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Info,
  Keyboard,
  ListMusic,
  Palette,
  Radio,
  Sliders,
  SlidersHorizontal,
  Stethoscope,
  User,
  Volume2
} from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { useGroupListenStore } from '../../store/useGroupListenStore';
import { PlaybackSettings } from '../settings/PlaybackSettings';
import { PlayerLayoutSettings } from '../settings/PlayerLayoutSettings';
import { AppearanceSettings } from '../settings/AppearanceSettings';
import { DesignSettings } from '../settings/DesignSettings';
import { LibrarySettings } from '../settings/LibrarySettings';
import { OfflineSettings } from '../settings/OfflineSettings';
import { AccountSettings } from '../settings/AccountSettings';
import { DesktopSettings } from '../settings/DesktopSettings';
import { DiagnosticsSettings } from '../settings/DiagnosticsSettings';
import { ResolveLogSettings } from '../settings/ResolveLogSettings';
import { ShortcutsSettings } from '../settings/ShortcutsSettings';
import { MobileUpdateSection } from '../settings/MobileUpdateSection';
import { AboutSettings } from '../settings/AboutSettings';
import { AppLayoutSettings } from '../settings/AppLayoutSettings';
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
  /**
   * Раздел, который не разворачивается, а открывает своё окно.
   *
   * Комната совместного прослушивания — не набор переключателей, а отдельный
   * разговор: код, участники, приглашение. Вкладывать её в список настроек
   * значило бы отдать ей пол-экрана под чужой рамкой.
   */
  onOpen?: () => void;
}

export const MobileSettingsView: React.FC = () => {
  const setActiveView = useUIStore((s) => s.setActiveView);
  const [openId, setOpenId] = useState<string | null>(null);
  const setGroupModalOpen = useGroupListenStore((s) => s.setModalOpen);

  const sections = useMemo<SectionEntry[]>(() => {
    const entries: SectionEntry[] = [
      { id: 'layout', label: 'Конструктор главной', hint: 'Панели, вкладки и блоки', icon: <SlidersHorizontal size={ICON.lg} />, render: () => <AppLayoutSettings /> },
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
        id: 'together',
        label: 'Слушать вместе',
        hint: 'Комната, где играет одно и то же',
        icon: <Radio size={ICON.lg} />,
        render: () => null,
        onOpen: () => setGroupModalOpen(true)
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
    } else {
      // На телефоне своего журнала у главного процесса нет — есть журнал попыток.
      entries.push({
        id: 'diagnostics',
        label: 'Диагностика',
        hint: 'Почему трек не играет',
        icon: <Stethoscope size={ICON.lg} />,
        render: () => <ResolveLogSettings />
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
      render: () => (
        <>
          {/* Обновление на телефоне ставится не так, как на компьютере, — у него
              свой раздел рядом с версией. */}
          <MobileUpdateSection />
          <AboutSettings />
        </>
      )
    });
    return entries;
  }, []);

  const open = sections.find((section) => section.id === openId) ?? null;

  if (open) {
    return (
      <div className="stack gap-4" data-testid="mobile-settings-section">
        {/*
          * Заголовка здесь нет намеренно: раздел называет себя сам — каждый из
          * них обёрнут в `SettingsSection`, а та рисует свой `h2` с описанием.
          * Собственный заголовок страницы дал бы «Воспроизведение» дважды
          * подряд, одно под другим.
          */}
        <header className="row">
          <BackButton onClick={() => setOpenId(null)} testId="mobile-settings-back" />
        </header>
        {open.render()}
      </div>
    );
  }

  return (
    <div className="stack gap-4" data-testid="mobile-settings">
      <header className="row gap-2">
        <BackButton onClick={() => setActiveView('home')} testId="mobile-settings-home" />
        <h1
          className="m-0 min-0 weight-bold text-primary type-2xl"
        >
          Настройки
        </h1>
      </header>

      <div
        className="radius-lg overflow-hidden bg-surface-2 border-subtle"
      >
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            className="menu-item-hover press row gap-4 w-full text-left text-primary pointer py-2 px-4"
            onClick={() => (section.onOpen ? section.onOpen() : setOpenId(section.id))}
            style={{ minHeight: '56px' }}
            data-testid={`mobile-settings-row-${section.id}`}
          >
            <span className="row-stretch shrink-0 text-secondary">{section.icon}</span>
            <span className="stack grow gap-px">
              <span
                className="text-truncate text-base leading-base tracking-base"
              >
                {section.label}
              </span>
              {/* Две строки, а не одна: в широком Unbounded подсказка на 390 px
                  не влезала и теряла последнее слово («Громкость, тембр, перехо…»). */}
              <span
                className="text-clamp-2 text-sm text-muted leading-sm tracking-sm"
              >
                {section.hint}
              </span>
            </span>
            <ChevronRight size={ICON.md} className="shrink-0 text-faint" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
};

const BackButton: React.FC<{ onClick: () => void; testId: string }> = ({ onClick, testId }) => (
  <button
    type="button"
    className="press focus-ring row justify-center shrink-0 text-secondary pointer"
    onClick={onClick}
    aria-label="Назад"
    style={{ width: '44px', height: '44px', marginLeft: 'calc(var(--space-3) * -1)', borderRadius: 'var(--radius-pill)' }}
    data-testid={testId}
  >
    <ChevronLeft size={ICON.xl} aria-hidden="true" />
  </button>
);
