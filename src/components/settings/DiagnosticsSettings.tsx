import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ClipboardCopy, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../common/Button';
import { SettingsSection, SettingRow, InfoRow } from './SettingsPrimitives';
import { useUIStore } from '../../store/useUIStore';
import { StreamDiagnostics } from '../../types/electron';
import { COOKIE_BROWSER_OPTIONS, youtubeCookiesService } from '../../services/youtubeCookies';
import { ICON } from '../../styles/icons';

/** Only the desktop build resolves streams itself, so only it has a log. */
function hasDiagnosticsBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.getStreamDiagnostics === 'function';
}

interface LogStats {
  resolved: number;
  failed: number;
  probeRejected: number;
  cacheHits: number;
}

/**
 * Counts what the log actually says. The probe rejections matter most: they are
 * the URLs YouTube handed over and then refused to serve, which is what a
 * listener experiences as "it just doesn't play".
 */
export function summarizeStreamLog(lines: readonly string[]): LogStats {
  const stats: LogStats = { resolved: 0, failed: 0, probeRejected: 0, cacheHits: 0 };
  for (const line of lines) {
    if (line.includes('failed probe:')) stats.probeRejected += 1;
    else if (line.includes('resolved ')) stats.resolved += 1;
    else if (line.includes('all attempts failed') || line.includes('terminal failure')) stats.failed += 1;
    else if (line.includes('cache hit')) stats.cacheHits += 1;
  }
  return stats;
}

/** `[2026-08-17T09:12:44.101Z] resolved …` → `12:44` + the message. */
function splitLogLine(line: string): { time: string; message: string } {
  const match = /^\[([^\]]+)\]\s?(.*)$/.exec(line);
  if (!match) return { time: '', message: line };
  const parsed = new Date(match[1]);
  const time = Number.isNaN(parsed.getTime())
    ? match[1]
    : parsed.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return { time, message: match[2] };
}

function lineTone(message: string): string {
  if (message.includes('failed probe:')) return 'var(--warning)';
  if (message.includes('all attempts failed') || message.includes('terminal failure')) return 'var(--danger)';
  if (message.includes('не от робота') || message.includes('bot check')) return 'var(--danger)';
  if (message.startsWith('resolved ')) return 'var(--text-secondary)';
  return 'var(--text-muted)';
}

/**
 * Playback diagnostics. Point of the panel: when a track refuses to play, the
 * reason is already written down — this makes it readable without opening a
 * terminal, and gives the two fixes that actually help (drop the cached URLs,
 * copy the report).
 */
export const DiagnosticsSettings: React.FC = () => {
  const showToast = useUIStore((s) => s.showToast);
  const [diagnostics, setDiagnostics] = useState<StreamDiagnostics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cookiesBrowser, setCookiesBrowser] = useState<string | null>(() => youtubeCookiesService.get());
  const isDesktop = hasDiagnosticsBridge();

  const refresh = useCallback(async (): Promise<void> => {
    const bridge = typeof window !== 'undefined' ? window.electronAPI?.getStreamDiagnostics : undefined;
    if (!bridge) return;
    setIsLoading(true);
    try {
      setDiagnostics(await bridge());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Настройка живёт в базе, а состояние компонента поднимается раньше, чем
  // сервис успевает её прочитать — поэтому значение забирается ещё раз.
  useEffect(() => {
    let alive = true;
    void youtubeCookiesService.init().then(() => {
      if (alive) setCookiesBrowser(youtubeCookiesService.get());
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleCookiesChange = useCallback(
    async (value: string): Promise<void> => {
      const next = value === 'off' ? null : value;
      const applied = await youtubeCookiesService.set(next);
      setCookiesBrowser(applied);
      showToast(
        applied
          ? `Для YouTube будем брать cookies из ${applied}. Войдите в YouTube в этом браузере, если ещё не вошли.`
          : 'Cookies браузера больше не используются.',
        'success'
      );
      await refresh();
    },
    [refresh, showToast]
  );

  const handleClearCache = useCallback(async (): Promise<void> => {
    const bridge = typeof window !== 'undefined' ? window.electronAPI?.clearStreamCache : undefined;
    if (!bridge) return;
    setIsClearing(true);
    try {
      await bridge();
      showToast('Кэш ссылок сброшен — следующее воспроизведение запросит новые.', 'success');
      await refresh();
    } catch (err) {
      showToast(`Не удалось сбросить кэш: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setIsClearing(false);
    }
  }, [refresh, showToast]);

  const handleCopy = useCallback(async (): Promise<void> => {
    if (!diagnostics) return;
    const report = [
      `yt-dlp: ${diagnostics.ytDlpAvailable ? 'найден' : 'НЕ НАЙДЕН'}`,
      `путь: ${diagnostics.ytDlpPath}`,
      `версия: ${diagnostics.ytDlpVersion ?? 'из установщика'}`,
      `cookies: ${diagnostics.cookiesBrowser ?? 'не используются'}`,
      `проверка «вы не робот»: ${diagnostics.botCheckSeen ? 'была в этом запуске' : 'не встречалась'}`,
      `журнал: ${diagnostics.logPath ?? '—'}`,
      '',
      ...diagnostics.log
    ].join('\n');

    try {
      await navigator.clipboard.writeText(report);
      showToast('Отчёт скопирован в буфер обмена.', 'success');
    } catch {
      showToast('Буфер обмена недоступен — журнал лежит в файле, путь указан выше.', 'error');
    }
  }, [diagnostics, showToast]);

  // Newest first: a failure that just happened is the one being investigated.
  const lines = useMemo(() => (diagnostics ? [...diagnostics.log].reverse() : []), [diagnostics]);
  const stats = useMemo(() => summarizeStreamLog(diagnostics?.log ?? []), [diagnostics]);

  // Свежесть извлекателя важнее его пути: именно из-за устаревшего yt-dlp
  // YouTube начинает отдавать ссылки, которые не играют.
  const extractorNote = useMemo(() => {
    if (!diagnostics) return 'Путь к бинарнику пока не получен.';
    const origin =
      diagnostics.ytDlpSource === 'managed' && diagnostics.ytDlpVersion
        ? `обновлён сам, версия ${diagnostics.ytDlpVersion}`
        : 'версия из установщика — обновится сама в течение суток';
    return `${diagnostics.ytDlpPath} · ${origin}`;
  }, [diagnostics]);

  if (!isDesktop) return null;

  return (
    <SettingsSection
      id="diagnostics"
      title="Диагностика воспроизведения"
      description="Здесь видно, почему трек не заиграл. Wireon Sounds перебирает пять конфигураций клиента YouTube и проверяет ссылку до начала воспроизведения — каждая попытка попадает в журнал."
    >
      <InfoRow
        label="Извлекатель yt-dlp"
        description={extractorNote}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: '2px var(--space-2)',
            borderRadius: 'var(--radius-full)',
            border: '1px solid var(--border-subtle)',
            background: diagnostics?.ytDlpAvailable === false ? 'var(--danger-soft)' : 'var(--surface-2)',
            color: diagnostics?.ytDlpAvailable === false ? 'var(--danger)' : 'var(--text-secondary)',
            fontSize: 'var(--text-xs)'
          }}
          data-testid="diagnostics-ytdlp-status"
        >
          {diagnostics?.ytDlpAvailable === false ? <AlertTriangle size={ICON.xs} /> : <CheckCircle2 size={ICON.xs} />}
          {diagnostics === null ? 'Проверяем…' : diagnostics.ytDlpAvailable ? 'Найден' : 'Не найден'}
        </span>
      </InfoRow>

      {diagnostics?.ytDlpAvailable === false && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)'
          }}
          data-testid="diagnostics-ytdlp-missing"
        >
          Без yt-dlp воспроизведение с YouTube не работает вообще. Переустановите приложение
          или запустите «npm run postinstall», чтобы догрузить бинарник.
        </p>
      )}

      <div className="divider" />

      <SettingRow
        label="Cookies браузера для YouTube"
        controlId="diagnostics-cookies-browser"
        description="YouTube иногда требует подтвердить, что запросы идут не от робота, и анонимно это не обойти. Выберите браузер, в котором вы вошли в YouTube, — Wireon Sounds возьмёт оттуда сессию, но только когда без неё не выходит."
      >
        <select
          id="diagnostics-cookies-browser"
          value={cookiesBrowser ?? 'off'}
          onChange={(e) => void handleCookiesChange(e.target.value)}
          data-testid="diagnostics-cookies-browser"
          style={{ minWidth: '150px' }}
        >
          <option value="off">Не использовать</option>
          {COOKIE_BROWSER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      {diagnostics?.botCheckSeen === true && !cookiesBrowser && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            fontSize: 'var(--text-xs)',
            lineHeight: 'var(--leading-xs)'
          }}
          data-testid="diagnostics-bot-check"
        >
          YouTube уже требовал подтверждения «вы не робот» в этом запуске. Пока cookies не выбраны,
          часть треков играть не будет — выберите браузер выше или слушайте версию с SoundCloud.
        </p>
      )}

      <div className="divider" />

      <InfoRow
        label="Последние попытки"
        description="Считается по записям в журнале ниже. «Ссылка отклонена» — YouTube выдал адрес и сам же отказался его отдавать; Wireon Sounds в этом случае берёт другой клиент."
      >
        <span
          data-numeric
          style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}
          data-testid="diagnostics-stats"
        >
          {stats.resolved} успешно · {stats.probeRejected} ссылка отклонена · {stats.failed} ошибок ·{' '}
          {stats.cacheHits} из кэша
        </span>
      </InfoRow>

      <SettingRow
        label="Журнал попыток"
        controlId="diagnostics-refresh"
        description={
          diagnostics?.logPath
            ? `Полный журнал: ${diagnostics.logPath}`
            : 'Журнал ведётся в папке данных приложения.'
        }
      >
        <Button
          id="diagnostics-refresh"
          variant="secondary"
          size="sm"
          icon={<RefreshCw size={ICON.sm} />}
          isLoading={isLoading}
          onClick={() => void refresh()}
          data-testid="diagnostics-refresh"
        >
          Обновить
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<ClipboardCopy size={ICON.sm} />}
          disabled={!diagnostics}
          onClick={() => void handleCopy()}
          data-testid="diagnostics-copy"
        >
          Скопировать отчёт
        </Button>
      </SettingRow>

      {error && (
        <p
          role="alert"
          style={{ margin: 0, fontSize: 'var(--text-xs)', color: 'var(--danger)' }}
          data-testid="diagnostics-error"
        >
          Не удалось прочитать журнал: {error}
        </p>
      )}

      <div
        style={{
          maxHeight: '220px',
          overflowY: 'auto',
          padding: 'var(--space-3)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)',
          background: 'var(--surface-1)',
          display: 'flex',
          flexDirection: 'column',
          gap: '2px'
        }}
        data-testid="diagnostics-log"
      >
        {lines.length === 0 ? (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {isLoading ? 'Читаем журнал…' : 'Журнал пуст — ни одной попытки воспроизведения в этой сборке.'}
          </span>
        ) : (
          lines.map((line, index) => {
            const { time, message } = splitLogLine(line);
            return (
              <div
                key={`${index}-${line.slice(0, 24)}`}
                style={{ display: 'flex', gap: 'var(--space-3)', fontSize: 'var(--text-xs)' }}
              >
                <span data-numeric style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                  {time}
                </span>
                <span style={{ color: lineTone(message), wordBreak: 'break-word' }}>{message}</span>
              </div>
            );
          })
        )}
      </div>

      <SettingRow
        label="Сбросить кэш ссылок"
        controlId="diagnostics-clear-cache"
        description="Ссылки YouTube живут несколько часов. Если компьютер уходил в сон, сохранённые адреса уже мертвы — сброс заставит запросить свежие."
      >
        <Button
          id="diagnostics-clear-cache"
          variant="secondary"
          size="sm"
          icon={<Trash2 size={ICON.sm} />}
          isLoading={isClearing}
          onClick={() => void handleClearCache()}
          data-testid="diagnostics-clear-cache"
        >
          Сбросить
        </Button>
      </SettingRow>
    </SettingsSection>
  );
};

export default DiagnosticsSettings;
