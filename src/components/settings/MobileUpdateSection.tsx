import React, { useEffect, useState } from 'react';
import { SettingsSection } from './SettingsPrimitives';
import {
  AvailableUpdate,
  checkForUpdate,
  downloadAndInstall,
  getInstalledVersion
} from '../../services/androidUpdater';

/**
 * Обновление на телефоне.
 *
 * На компьютере обновление ставится само; здесь так нельзя — Android показывает
 * своё окно установки, и подтверждает её человек. Поэтому экран честно ведёт
 * его по шагам: проверить, скачать, подтвердить.
 *
 * Ничего не проверяется само при открытии настроек: запрос в сеть и сорок
 * мегабайт по мобильному тарифу — не то, что делают без спроса.
 */
export const MobileUpdateSection: React.FC = () => {
  const [installed, setInstalled] = useState<string | null>(null);
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getInstalledVersion().then((version) => {
      if (alive) setInstalled(version);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Не телефон — раздела нет вовсе: на компьютере обновлением занимается сам
  // установщик, и вторая кнопка рядом только путала бы.
  if (!installed) return null;

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setUpdate(await checkForUpdate());
      setChecked(true);
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!update) return;
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      await downloadAndInstall(update, setProgress);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      id="mobile-update"
      title="Обновление"
      description={`Установлена версия ${installed}.`}
    >
      {error && (
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--danger, #ff6b6b)' }}>{error}</p>
      )}

      {update ? (
        <>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
            Доступна версия {update.version} — {(update.size / 1048576).toFixed(0)} МБ.
          </p>
          {busy && progress > 0 && (
            <p style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              Скачиваем… {Math.round(progress * 100)}%
            </p>
          )}
          <button type="button" onClick={install} disabled={busy} data-testid="mobile-update-install" style={buttonStyle}>
            {busy ? 'Скачиваем…' : 'Обновить'}
          </button>
        </>
      ) : (
        <>
          {checked && !busy && (
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              Установлена последняя версия.
            </p>
          )}
          <button type="button" onClick={check} disabled={busy} data-testid="mobile-update-check" style={buttonStyle}>
            {busy ? 'Проверяем…' : 'Проверить обновления'}
          </button>
        </>
      )}
    </SettingsSection>
  );
};

const buttonStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  padding: '8px 14px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--surface-2)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-sm)',
  cursor: 'pointer'
};

export default MobileUpdateSection;
