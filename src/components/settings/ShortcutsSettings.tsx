import React, { useEffect, useRef, useState } from 'react';
import { SettingsSection, ToggleSetting } from './SettingsPrimitives';
import { usePlayerStore } from '../../store/usePlayerStore';
import { eventToAccelerator, formatAccelerator } from '../../utils/accelerators';

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

/** Действия, которым можно назначить клавишу на весь компьютер. */
const GLOBAL_ACTIONS: ReadonlyArray<{ action: string; label: string }> = [
  { action: 'play-pause', label: 'Играть / пауза' },
  { action: 'next', label: 'Следующий трек' },
  { action: 'prev', label: 'Предыдущий трек' },
  { action: 'volume-up', label: 'Громче' },
  { action: 'volume-down', label: 'Тише' }
];

/**
 * Сочетания, работающие поверх других программ.
 *
 * Отличаются от списка ниже тем, что не требуют переключаться в окно: их
 * занимает система целиком. Поэтому одинокая клавиша здесь запрещена — иначе
 * буква перестала бы печататься во всех программах сразу.
 */
const GlobalHotkeysSection: React.FC = () => {
  const enabled = usePlayerStore((s) => s.globalHotkeysEnabled);
  const bindings = usePlayerStore((s) => s.globalHotkeys);
  const setEnabled = usePlayerStore((s) => s.setGlobalHotkeysEnabled);
  const setHotkey = usePlayerStore((s) => s.setGlobalHotkey);
  const resetHotkeys = usePlayerStore((s) => s.resetGlobalHotkeys);

  const [recording, setRecording] = useState<string | null>(null);
  const recordingRef = useRef<string | null>(null);
  recordingRef.current = recording;

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setRecording(null);
        return;
      }
      // Backspace снимает назначение: действие останется без клавиши.
      if (event.key === 'Backspace' || event.key === 'Delete') {
        setHotkey(recordingRef.current as string, '');
        setRecording(null);
        return;
      }

      const accelerator = eventToAccelerator(event);
      if (!accelerator) return; // ещё не сочетание — ждём следующего нажатия

      setHotkey(recordingRef.current as string, accelerator);
      setRecording(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, setHotkey]);

  return (
    <SettingsSection
      id="global-hotkeys"
      title="Сочетания поверх других программ"
      description="Работают, даже когда окно Wireon закрыто за другим окном. Занятое другой программой сочетание видно в разделе «Диагностика»."
    >
      <ToggleSetting
        id="global-hotkeys-enabled"
        label="Включить"
        description="Wireon займёт эти сочетания на весь компьютер."
        checked={enabled}
        onChange={setEnabled}
      />

      <ul style={{ listStyle: 'none', margin: 'var(--space-3) 0 0', padding: 0, display: 'grid', gap: 'var(--space-2)' }}>
        {GLOBAL_ACTIONS.map(({ action, label }) => (
          <li
            key={action}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              fontSize: 'var(--text-sm)',
              color: enabled ? 'var(--text-primary)' : 'var(--text-muted)'
            }}
          >
            <span>{label}</span>
            <button
              type="button"
              disabled={!enabled}
              onClick={() => setRecording(action)}
              aria-label={`Изменить сочетание: ${label}`}
              style={{
                ...kbdStyle,
                cursor: enabled ? 'pointer' : 'default',
                minWidth: '150px',
                justifyContent: 'center',
                borderColor: recording === action ? 'var(--accent)' : 'var(--border-subtle)',
                color: recording === action ? 'var(--accent)' : 'var(--text-secondary)'
              }}
            >
              {recording === action ? 'нажмите сочетание…' : formatAccelerator(bindings[action] || '')}
            </button>
          </li>
        ))}
      </ul>

      <p style={{ margin: 'var(--space-2) 0 0', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
        Во время записи: Esc — отменить, Backspace — снять клавишу с действия.
      </p>

      <button
        type="button"
        onClick={resetHotkeys}
        style={{
          marginTop: 'var(--space-3)',
          padding: '6px 12px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-subtle)',
          background: 'var(--surface-2)',
          color: 'var(--text-secondary)',
          fontSize: 'var(--text-xs)',
          cursor: 'pointer'
        }}
      >
        Вернуть стандартные
      </button>
    </SettingsSection>
  );
};

/** A read-only cheatsheet. Shortcuts themselves live in `useKeyboardShortcuts`. */
export const ShortcutsSettings: React.FC = () => {
  const mod = isMacLike() ? '⌘' : 'Ctrl';

  return (
    <>
      <GlobalHotkeysSection />
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
    </>
  );
};

export default ShortcutsSettings;
