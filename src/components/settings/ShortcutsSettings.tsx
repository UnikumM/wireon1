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

/**
 * Повторяет `useKeyboardShortcuts` один в один — менять только вместе.
 *
 * Буквы названы по клавишам: в русской раскладке `M` — это клавиша с «Ь», и
 * срабатывает она так же.
 */
function shortcuts(mod: string, alt: string): Shortcut[] {
  return [
    { keys: ['Space'], action: 'Играть / пауза' },
    { keys: ['←'], action: 'Назад на 5 секунд' },
    { keys: ['→'], action: 'Вперёд на 5 секунд' },
    { keys: ['Shift', '←'], action: 'Предыдущий трек' },
    { keys: ['Shift', '→'], action: 'Следующий трек' },
    { keys: ['M'], action: 'Выключить / включить звук' },
    { keys: ['L'], action: 'В любимое / убрать' },
    { keys: ['D'], action: 'Не нравится — пропустить' },
    { keys: ['F'], action: 'Полноэкранный режим' },
    { keys: ['Q'], action: 'Очередь' },
    { keys: [alt, 'M'], action: 'Мини-плеер' },
    { keys: [alt, 'W'], action: 'Поток: открыть, пуск / пауза' },
    { keys: [alt, 'R'], action: 'Радио по текущему треку' },
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

      <ul className="p-0 grid gap-2 list-none" style={{ margin: 'var(--space-3) 0 0' }}>
        {GLOBAL_ACTIONS.map(({ action, label }) => (
          <li
            key={action}
            className="row justify-between gap-4 text-sm" style={{ color: enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}
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

      <p className="text-xs text-muted" style={{ margin: 'var(--space-2) 0 0' }}>
        Во время записи: Esc — отменить, Backspace — снять клавишу с действия.
      </p>

      <SystemShortcutHint />

      <button
        type="button"
        onClick={resetHotkeys}
        className="mt-3 radius-sm text-secondary text-xs pointer border-subtle bg-surface-2" style={{ padding: '6px 12px' }}
      >
        Вернуть стандартные
      </button>
    </SettingsSection>
  );
};

/**
 * Команды для сочетаний, назначенных в самой системе: `Wireon --next`.
 *
 * На Wayland окно не вправе занять клавишу само: это делает рабочий стол, и на
 * части из них (GNOME) у Electron это пока не получается. Поэтому там подсказка
 * раскрыта сразу и говорит прямо. На Windows и X11 — свёрнута: свои сочетания
 * там работают, а команда нужна разве что для макросов и кнопок мыши.
 */
const SystemShortcutHint: React.FC = () => {
  const [control, setControl] = useState<{ command: string; wayland: boolean; desktop: string | null } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.electronAPI
      ?.getStreamDiagnostics?.()
      .then((diagnostics) => {
        if (alive && diagnostics?.hotkeyControl) setControl(diagnostics.hotkeyControl);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!control) return null;

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(text),
      () => {}
    );
  };

  const commands = (
    <ul className="p-0 grid gap-1 list-none" style={{ margin: 'var(--space-2) 0 0' }}>
      {GLOBAL_ACTIONS.map(({ action, label }) => {
        const line = `${control.command} --${action}`;
        return (
          <li key={action} className="row gap-2 min-0">
            <span className="shrink-0 text-secondary" style={{ minWidth: '130px' }}>{label}</span>
            <code
              className="text-truncate grow text-xs text-muted"
              title={line}
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {line}
            </code>
            <button
              type="button"
              onClick={() => copy(line)}
              style={{ ...kbdStyle, cursor: 'pointer', flexShrink: 0 }}
              aria-label={`Скопировать команду: ${label}`}
            >
              {copied === line ? 'скопировано' : 'копировать'}
            </button>
          </li>
        );
      })}
    </ul>
  );

  const gnome = /gnome/i.test(control.desktop || '');
  const intro = control.wayland
    ? `На Wayland сочетания выдаёт рабочий стол${
        gnome ? ', и в GNOME Wireon пока не может их занять' : ' — при первом включении он может спросить разрешение'
      }. Если клавиши не срабатывают, назначьте их в настройках системы (в GNOME: Настройки → Клавиатура → Свои комбинации клавиш) на эти команды:`
    : 'Сочетание можно назначить и в самой системе или на кнопку мыши — на эти команды. Окно при этом не всплывает.';

  return (
    <div
      data-testid="system-shortcut-hint"
      style={{
        marginTop: 'var(--space-3)',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-sm)',
        border: `1px solid ${control.wayland ? 'var(--border-accent)' : 'var(--border-subtle)'}`,
        fontSize: 'var(--text-xs)',
        color: 'var(--text-secondary)'
      }}
    >
      {control.wayland ? (
        <>
          <p className="m-0">{intro}</p>
          {commands}
        </>
      ) : (
        <details>
          <summary className="pointer">Команды для системных сочетаний</summary>
          <p style={{ margin: 'var(--space-2) 0 0' }}>{intro}</p>
          {commands}
        </details>
      )}
    </div>
  );
};

/** Шпаргалка только для чтения. Сами сочетания живут в `useKeyboardShortcuts`. */
export const ShortcutsSettings: React.FC = () => {
  const mac = isMacLike();
  const mod = mac ? '⌘' : 'Ctrl';
  const alt = mac ? 'Option' : 'Alt';

  return (
    <div className="stack gap-5">
      <GlobalHotkeysSection />
      <SettingsSection
      id="shortcuts"
      title="Горячие клавиши"
      description={`Работают в любой раскладке — по клавише, а не по букве на ней. Пока курсор в поле ввода, срабатывает только ${mod} + K.`}
    >
      <ul
        className="m-0 p-0 grid list-none" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--space-2) var(--space-6)' }}
      >
        {shortcuts(mod, alt).map((shortcut) => (
          <li
            key={shortcut.action}
            className="row justify-between gap-4 text-sm text-primary leading-sm"
          >
            <span>{shortcut.action}</span>
            <span className="inline-row shrink-0 gap-1">
              {shortcut.keys.map((key, i) => (
                <React.Fragment key={key}>
                  {i > 0 && <span className="text-muted text-xs">+</span>}
                  <kbd style={kbdStyle}>{key}</kbd>
                </React.Fragment>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </SettingsSection>
    </div>
  );
};

export default ShortcutsSettings;
