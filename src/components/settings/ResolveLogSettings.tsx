import React, { useEffect, useState } from 'react';
import { ClipboardCopy, Trash2 } from 'lucide-react';
import { Button } from '../common/Button';
import { SettingsSection } from './SettingsPrimitives';
import { useUIStore } from '../../store/useUIStore';
import {
  clearResolveLog,
  formatResolveLog,
  onResolveLog,
  readResolveLog,
  type ResolveLogEntry
} from '../../services/resolveLog';
import { ICON } from '../../styles/icons';

/**
 * «Диагностика» на телефоне: последние попытки открыть трек.
 *
 * Здесь нет ни пути к yt-dlp, ни cookies — это всё про компьютер. Зато видно
 * то, чего не было видно вовсе: какой источник отказал, чем и за сколько
 * секунд. «Скопировать» кладёт журнал текстом — его можно просто переслать.
 */
export const ResolveLogSettings: React.FC = () => {
  const showToast = useUIStore((s) => s.showToast);
  const [entries, setEntries] = useState<ReadonlyArray<ResolveLogEntry>>(() => readResolveLog());

  useEffect(() => onResolveLog(setEntries), []);

  const failed = entries.filter((entry) => !entry.ok).length;
  const slow = entries.filter((entry) => entry.ms > 10000).length;
  const newestFirst = [...entries].reverse();

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatResolveLog(entries));
      showToast('Журнал скопирован', 'success');
    } catch {
      showToast('Не получилось скопировать', 'error');
    }
  };

  return (
    <SettingsSection
      id="resolve-log"
      title="Открытие треков"
      description="Последние попытки: какой источник ответил, сколько это заняло и почему не вышло. Если что-то не играет — скопируйте журнал и перешлите."
    >
      <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }} data-testid="resolve-log-summary">
        {entries.length === 0
          ? 'Пока пусто: журнал заполнится, когда включите что-нибудь.'
          : `Попыток: ${entries.length}, не вышло: ${failed}, дольше 10 секунд: ${slow}.`}
      </p>

      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" onClick={copy} disabled={entries.length === 0} data-testid="resolve-log-copy">
          <ClipboardCopy size={ICON.sm} aria-hidden="true" />
          Скопировать
        </Button>
        <Button variant="ghost" size="sm" onClick={clearResolveLog} disabled={entries.length === 0} data-testid="resolve-log-clear">
          <Trash2 size={ICON.sm} aria-hidden="true" />
          Очистить
        </Button>
      </div>

      {newestFirst.length > 0 && (
        <ul
          style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--space-2)' }}
          data-testid="resolve-log"
        >
          {newestFirst.map((entry) => (
            <li
              key={`${entry.at}-${entry.title}`}
              style={{
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${entry.ok ? 'var(--border-subtle)' : 'var(--danger)'}`,
                fontSize: 'var(--text-xs)',
                color: 'var(--text-secondary)',
                minWidth: 0
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
                <span className="text-truncate" style={{ color: 'var(--text-primary)', minWidth: 0 }}>
                  {entry.title}
                </span>
                <span data-numeric style={{ flexShrink: 0, color: entry.ms > 10000 ? 'var(--warning)' : 'var(--text-muted)' }}>
                  {(entry.ms / 1000).toFixed(1)} с
                </span>
              </div>
              <div style={{ marginTop: '2px', wordBreak: 'break-word' }}>
                {entry.ok ? 'играет' : 'не вышло'} · {entry.source}
                {entry.prefetch ? ' · заранее' : ''} · {entry.detail}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
};
