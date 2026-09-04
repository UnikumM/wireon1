import React from 'react';
import { SettingsSection } from './SettingsPrimitives';

interface Shortcut {
  keys: string[];
  action: string;
}

function isMacLike(): boolean {
  const platform = window.electronAPI?.getPlatform?.();
  if (platform) return platform === 'darwin';
  return /mac|iphone|ipad/i.test(navigator.userAgent);
}

/** Mirrors `useKeyboardShortcuts` exactly — update both together. */
function shortcuts(mod: string): Shortcut[] {
  return [
    { keys: ['Space'], action: 'Играть / пауза' },
    { keys: ['←'], action: 'Назад на 5 секунд' },
    { keys: ['→'], action: 'Вперёд на 5 секунд' },
    { keys: ['Shift', '←'], action: 'Предыдущий трек' },
    { keys: ['Shift', '→'], action: 'Следующий трек' },
    { keys: ['M'], action: 'Выключить / включить звук' },
    { keys: ['F'], action: 'Полноэкранный режим' },
    { keys: ['Q'], action: 'Очередь' },
    { keys: ['/'], action: 'Перейти к поиску' },
    { keys: [mod, 'K'], action: 'Палитра команд' },
    { keys: ['Esc'], action: 'Закрыть верхнее окно' }
  ];
}

const kbdStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '24px',
  padding: '2px 6px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--surface-2)',
  color: 'var(--text-secondary)',
  fontFamily: 'inherit',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.4
};

/** A read-only cheatsheet. Shortcuts themselves live in `useKeyboardShortcuts`. */
export const ShortcutsSettings: React.FC = () => {
  const mod = isMacLike() ? '⌘' : 'Ctrl';

  return (
    <SettingsSection
      id="shortcuts"
      title="Горячие клавиши"
      description="Не срабатывают, пока курсор стоит в поле ввода."
    >
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 'var(--space-2) var(--space-6)'
        }}
      >
        {shortcuts(mod).map((shortcut) => (
          <li
            key={shortcut.action}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              color: 'var(--text-primary)'
            }}
          >
            <span>{shortcut.action}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
              {shortcut.keys.map((key, i) => (
                <React.Fragment key={key}>
                  {i > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>+</span>}
                  <kbd style={kbdStyle}>{key}</kbd>
                </React.Fragment>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
};

export default ShortcutsSettings;
