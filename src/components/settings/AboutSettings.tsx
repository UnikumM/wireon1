import React, { useCallback, useMemo, useState } from 'react';
import { ClipboardCopy, RefreshCw, ScrollText } from 'lucide-react';
import { Button } from '../common/Button';
import { WhatsNewSheet } from '../common/WhatsNewGate';
import { SettingsSection, InfoRow } from './SettingsPrimitives';
import { useUIStore } from '../../store/useUIStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useUpdateStore } from '../../store/useUpdateStore';
import type { UpdateStatus } from '../../types/electron';
import { entriesSince } from '../../data/changelog';
import { APP_VERSION, runtimeLabel } from '../../utils/appInfo';
import { ICON } from '../../styles/icons';

/** «Проверяли в 14:32» — по-местному и без секунд. */
function formatCheckedAt(checkedAt: number | null): string | null {
  if (!checkedAt) return null;
  try {
    return new Date(checkedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
}

export interface UpdateSummaryInput {
  hasBridge: boolean;
  status: UpdateStatus;
  newVersion: string | null;
  percent: number;
  message: string | null;
  checkedAt: number | null;
}

/**
 * Одна строка про обновления — на человеческом.
 *
 * Здесь же видно всё, что скрыто от глаз в остальное время: обновление качается
 * в фоне молча, и настройки — единственное место, где можно посмотреть, что
 * вообще происходит.
 */
export function describeUpdateState(input: UpdateSummaryInput): string {
  if (!input.hasBridge) {
    return 'Автообновление работает только в приложении Wireon Sounds.';
  }

  switch (input.status) {
    case 'unsupported':
      return input.message ?? 'Эта сборка не обновляется сама.';
    case 'checking':
      return 'Проверяем, есть ли новая версия…';
    case 'available':
      return input.newVersion
        ? `Нашли версию ${input.newVersion} — качаем в фоне.`
        : 'Нашли новую версию — качаем в фоне.';
    case 'downloading':
      return `Качаем обновление: ${input.percent}%. Можно продолжать слушать.`;
    case 'ready':
      return input.newVersion
        ? `Версия ${input.newVersion} скачана. Встанет при перезапуске — или сама, когда закроете приложение.`
        : 'Обновление скачано. Встанет при перезапуске приложения.';
    case 'error':
      return input.message ?? 'Проверить обновления не удалось.';
    case 'up-to-date': {
      const at = formatCheckedAt(input.checkedAt);
      return at ? `Установлена последняя версия. Проверяли в ${at}.` : 'Установлена последняя версия.';
    }
    case 'idle':
    default:
      return 'Проверяется само, раз в несколько часов.';
  }
}

export const AboutSettings: React.FC = () => {
  const showToast = useUIStore((s) => s.showToast);
  const lastError = usePlayerStore((s) => s.error);

  // Поля выбираются по одному: селектор, собирающий объект, отдавал бы новую
  // ссылку на каждый рендер и заставлял бы этот раздел перерисовываться зря.
  const hasBridge = useUpdateStore((s) => s.hasBridge);
  const status = useUpdateStore((s) => s.status);
  const currentVersion = useUpdateStore((s) => s.currentVersion);
  const newVersion = useUpdateStore((s) => s.newVersion);
  const percent = useUpdateStore((s) => s.percent);
  const updateMessage = useUpdateStore((s) => s.message);
  const checkedAt = useUpdateStore((s) => s.checkedAt);
  const isChecking = useUpdateStore((s) => s.isChecking);
  const checkForUpdates = useUpdateStore((s) => s.check);
  const installUpdate = useUpdateStore((s) => s.install);

  /**
   * Playback problems are nearly always an environment detail (runtime, which
   * mirror answered, the last engine error), so make that block copyable.
   */
  const copyDiagnostics = useCallback(async () => {
    const lines = [
      `Wireon Sounds ${APP_VERSION}`,
      `Среда: ${runtimeLabel()}`,
      `User agent: ${navigator.userAgent}`,
      `Последняя ошибка воспроизведения: ${lastError ?? 'нет'}`
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      showToast('Сведения скопированы в буфер обмена', 'success');
    } catch {
      showToast('Доступ к буферу обмена запрещён', 'error');
    }
  }, [lastError, showToast]);

  const canCheck = hasBridge && status !== 'unsupported';
  const isBusy = isChecking || status === 'checking' || status === 'downloading';
  const updateSummary = describeUpdateState({
    hasBridge,
    status,
    newVersion,
    percent,
    message: updateMessage,
    checkedAt
  });

  // Здесь показывается вся известная сборке история, а не только непрочитанное:
  // экран после обновления закрывают не читая, и вернуться к нему должно быть
  // можно в любой момент.
  const [isWhatsNewOpen, setIsWhatsNewOpen] = useState(false);
  const allEntries = useMemo(() => entriesSince('0.0.0', APP_VERSION), []);

  return (
    <SettingsSection id="about" title="О программе" description="Версия сборки и источники звука.">
      <InfoRow label="Версия">
        <span data-numeric style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          {hasBridge && currentVersion ? currentVersion : APP_VERSION}
        </span>
      </InfoRow>

      <InfoRow label="Среда">
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{runtimeLabel()}</span>
      </InfoRow>

      <InfoRow
        label="Источники звука"
        description="Потоки берутся напрямую у сервисов. Wireon Sounds ничего не хранит у себя и не проксирует."
      >
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>YouTube Music · SoundCloud</span>
      </InfoRow>

      <div className="divider" />

      <InfoRow label="Обновления" description={updateSummary}>
        {status === 'ready' ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => void installUpdate()}
            data-testid="about-update-install"
          >
            Перезапустить и обновить
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={ICON.sm} />}
            disabled={!canCheck || isBusy}
            onClick={() => void checkForUpdates()}
            data-testid="about-update-check"
          >
            {isBusy ? 'Проверяем…' : 'Проверить'}
          </Button>
        )}
      </InfoRow>

      {status === 'downloading' && (
        <div
          role="progressbar"
          aria-label="Загрузка обновления"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{
            height: '4px',
            // Токен, а не 999px: `--radius-full` для этого и есть.
            borderRadius: 'var(--radius-full)',
            backgroundColor: 'var(--surface-sunken)',
            overflow: 'hidden'
          }}
          data-testid="about-update-progress"
        >
          <div
            style={{
              width: `${percent}%`,
              height: '100%',
              backgroundColor: 'var(--accent)',
              // linear здесь намеренно, а не `--ease-out`: прогресс скачками
              // догоняет реальный процент, и кривая с торможением на каждом
              // шаге давала бы рывок-остановку вместо ровного роста. Токен
              // длительности при этом общий, и prefers-reduced-motion его
              // схлопывает вместе с остальными.
              transition: 'width var(--dur-normal) linear'
            }}
          />
        </div>
      )}

      <div className="divider" />

      <InfoRow
        label="Что нового"
        description={
          allEntries.length > 0
            ? `Список изменений — от версии ${allEntries[0].version} и ниже.`
            : 'Для этой сборки список изменений не заполнен.'
        }
      >
        <Button
          variant="ghost"
          size="sm"
          icon={<ScrollText size={ICON.sm} />}
          disabled={allEntries.length === 0}
          onClick={() => setIsWhatsNewOpen(true)}
          data-testid="about-whats-new"
        >
          Посмотреть
        </Button>
      </InfoRow>

      {isWhatsNewOpen && <WhatsNewSheet entries={allEntries} onClose={() => setIsWhatsNewOpen(false)} />}

      <div className="divider" />

      <InfoRow
        label="Сведения для поддержки"
        description="Версия, среда и последняя ошибка воспроизведения — обычным текстом."
      >
        <Button
          variant="ghost"
          size="sm"
          icon={<ClipboardCopy size={ICON.sm} />}
          onClick={() => void copyDiagnostics()}
          data-testid="about-diagnostics"
        >
          Скопировать
        </Button>
      </InfoRow>
    </SettingsSection>
  );
};

export default AboutSettings;
