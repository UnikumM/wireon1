import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { PlaybackSettings } from './PlaybackSettings';
import { PlayerLayoutSettings } from './PlayerLayoutSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { DesignSettings } from './DesignSettings';
import { LibrarySettings } from './LibrarySettings';
import { OfflineSettings } from './OfflineSettings';
import { AccountSettings } from './AccountSettings';
import { DesktopSettings } from './DesktopSettings';
import { DiagnosticsSettings } from './DiagnosticsSettings';
import { ShortcutsSettings } from './ShortcutsSettings';
import { AboutSettings } from './AboutSettings';
import { AppLayoutSettings } from './AppLayoutSettings';
import { useMediaQuery } from '../../hooks/useMediaQuery';

interface SectionEntry {
  id: string;
  label: string;
  render: () => React.ReactNode;
}

function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.setMediaKeysEnabled === 'function';
}

/** Diagnostics has its own bridge, so a chip is never offered for an empty panel. */
function hasDiagnosticsBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.getStreamDiagnostics === 'function';
}

/**
 * Settings page. Sections are plain siblings in one scroll column; the chip rail
 * only scrolls to them, so the page still works with scripting-free scrolling
 * and the sections stay independently testable.
 */
export const SettingsView: React.FC<{ className?: string }> = ({ className }) => {
  /** Одна подписка на весь экран настроек, а не на каждую строку в нём. */
  const isNarrow = useMediaQuery('(max-width: 768px)');

  const [activeId, setActiveId] = useState('playback');
  const containerRef = useRef<HTMLDivElement | null>(null);

  // `DesktopSettings` and `DiagnosticsSettings` render nothing outside Electron,
  // so their chips must go too.
  const sections = useMemo<SectionEntry[]>(() => {
    const entries: SectionEntry[] = [
      { id: 'playback', label: 'Воспроизведение', render: () => <PlaybackSettings /> },
      { id: 'player', label: 'Плеер', render: () => <PlayerLayoutSettings /> },
      { id: 'layout', label: 'Конструктор', render: () => <AppLayoutSettings /> },
      { id: 'appearance', label: 'Внешний вид', render: () => <AppearanceSettings /> },
      { id: 'design', label: 'Оформление', render: () => <DesignSettings /> },
      { id: 'library', label: 'Медиатека', render: () => <LibrarySettings /> },
      { id: 'offline', label: 'Офлайн', render: () => <OfflineSettings /> },
      { id: 'account', label: 'Аккаунт', render: () => <AccountSettings /> }
    ];
    if (hasDesktopBridge()) {
      entries.push({ id: 'desktop', label: 'Приложение', render: () => <DesktopSettings /> });
    }
    if (hasDiagnosticsBridge()) {
      entries.push({ id: 'diagnostics', label: 'Диагностика', render: () => <DiagnosticsSettings /> });
    }
    entries.push({ id: 'shortcuts', label: 'Горячие клавиши', render: () => <ShortcutsSettings /> });
    entries.push({ id: 'about', label: 'О программе', render: () => <AboutSettings /> });
    return entries;
  }, []);

  const jumpTo = useCallback((id: string) => {
    setActiveId(id);
    // К обёртке раздела, а не к `settings-section-<id>`: у «Конструктора» своя
    // разметка без этого testid, и кнопка молча никуда не вела.
    const target = containerRef.current?.querySelector(`[data-section-id="${id}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Highlights whichever section is nearest the top of the viewport. Guarded
  // because jsdom and older WebViews have no IntersectionObserver.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.getAttribute('data-section-id');
        if (id) setActiveId(id);
      },
      { rootMargin: '-8% 0px -70% 0px', threshold: 0 }
    );

    root.querySelectorAll('[data-section-id]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [sections]);

  return (
    <div
      ref={containerRef}
      // The entry animation goes on the whole page rather than on each section:
      // eleven sections animating at once would each get its own compositor
      // layer, and the settings page is the longest tree in the app.
      className={clsx('animate-view-in stack gap-5 w-full', className)}
      data-testid="settings-view"
    >
      {/*
        * На телефоне этого заголовка нет: слово «Настройки» уже стоит в шапке
        * приложения прямо над ним. Вместе с подписью они занимали 80 px, а до
        * первой настройки и без них уходило больше половины экрана.
        */}
      {!isNarrow && (
        <div className="stack gap-1">
          <h1
            className="m-0 weight-semibold text-primary type-2xl"
          >
            Настройки
          </h1>
          <p className="m-0 text-sm text-muted">
            Изменения сохраняются на этом устройстве сразу.
          </p>
        </div>
      )}

      {/*
        * Категории — простым списком сбоку, как в Discord. Раньше это был ряд
        * пилюль на сплошной полосе фона: полоса резала прокручиваемые
        * настройки, а над ней ещё просвечивал их край. Вид — в `.settings-nav`
        * (global.css): на узком окне список становится рядом с размытым фоном.
        */}
      <div className="settings-layout">
        <nav aria-label="Разделы настроек" className="settings-nav scroll-x-quiet">
          {sections.map((section) => {
            const isActive = section.id === activeId;
            return (
              <button
                key={section.id}
                type="button"
                className="settings-nav-item focus-ring"
                aria-pressed={isActive}
                onClick={() => jumpTo(section.id)}
                data-testid={`settings-nav-${section.id}`}
              >
                {section.label}
              </button>
            );
          })}
        </nav>

        <div className="stack gap-5 min-0">
          {sections.map((section) => (
            <div key={section.id} data-section-id={section.id}>
              {section.render()}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SettingsView;
