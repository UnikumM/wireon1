import React, { useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw, Send, X } from 'lucide-react';
import { usePlayerStore } from '../../../store/usePlayerStore';
import { useUIStore } from '../../../store/useUIStore';
import { describePlaybackAttempts } from '../../../services/playbackErrors';
import { sendUserReport } from '../../../services/telemetry';
import { Button } from '../../common/Button';
import { ICON } from '../../../styles/icons';

/**
 * Скрытие ошибки живёт здесь, а не в сторе: у стора нет действия «забыть
 * ошибку», и это правильно — она исчезает сама, когда трек меняется (загрузка
 * сбрасывает `error` в null). Панель прячется до следующей ошибки.
 */
function useVisiblePlaybackError() {
  const error = usePlayerStore((s) => s.error);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (error === null) setDismissed(null);
  }, [error]);

  return {
    error: error !== null && error !== dismissed ? error : null,
    dismiss: () => setDismissed(error)
  };
}

export interface PlaybackErrorPanelProps {
  /**
   * `bar` — полная панель над полосой плеера на ПК: заголовок, строка «что
   * попробовали» и три действия. `compact` — одна строка над плашкой на
   * телефоне: текст, «Повторить» и «Скрыть».
   */
  variant: 'bar' | 'compact';
  className?: string;
}

type ReportState = 'idle' | 'sending' | 'sent';

/**
 * Панель ошибки воспроизведения: что случилось, что приложение уже
 * попробовало, что можно сделать.
 *
 * Первая строка — человеческая фраза из `playbackErrors.ts`; техническая
 * причина остаётся в `title`, чтобы её можно было скопировать для отчёта.
 * «Повторить» открывает трек заново через `play()`: после отказа элемент
 * стоит в ошибке, и стор сам берёт свежую ссылку. «Отправить отчёт» шлёт
 * текст ошибки, причину, id трека и источник на наш сервер.
 */
export const PlaybackErrorPanel: React.FC<PlaybackErrorPanelProps> = ({ variant, className = '' }) => {
  const { error, dismiss } = useVisiblePlaybackError();
  const errorDetail = usePlayerStore((s) => s.errorDetail);
  const errorCanRetry = usePlayerStore((s) => s.errorCanRetry);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const substitutedFrom = usePlayerStore((s) => s.substitutedFrom);
  const play = usePlayerStore((s) => s.play);
  const showToast = useUIStore((s) => s.showToast);

  const [report, setReport] = useState<ReportState>('idle');

  // Новая ошибка — новый отчёт: «отправлено» относилось к прошлой.
  useEffect(() => {
    setReport('idle');
  }, [error, errorDetail]);

  if (error === null) return null;

  const attempts = describePlaybackAttempts(errorDetail, currentTrack?.source, substitutedFrom);

  const retry = () => {
    void play();
  };

  const sendReport = async () => {
    if (report !== 'idle') return;
    setReport('sending');
    const sent = await sendUserReport({
      message: error,
      detail: errorDetail,
      trackId: currentTrack?.id ?? null,
      source: currentTrack?.source ?? null
    });
    if (sent) {
      setReport('sent');
      showToast('Отчёт отправлен', 'success');
    } else {
      setReport('idle');
      showToast('Не удалось отправить отчёт. Проверьте соединение.', 'error');
    }
  };

  const retryButton = errorCanRetry ? (
    <Button
      variant="secondary"
      size="xs"
      onClick={retry}
      icon={<RotateCcw size={ICON.xs} aria-hidden="true" />}
      data-testid="player-error-retry"
    >
      Повторить
    </Button>
  ) : null;

  const dismissButton = (
    <Button
      variant="ghost"
      size="icon"
      onClick={dismiss}
      aria-label="Скрыть ошибку"
      title="Скрыть"
      className="control-sm text-muted"
      data-testid="player-error-dismiss"
    >
      <X size={ICON.sm} />
    </Button>
  );

  if (variant === 'compact') {
    return (
      <div
        role="alert"
        className={`playback-error-panel-compact row gap-2 px-3 py-2 ${className}`}
        data-testid="player-error"
      >
        <AlertTriangle size={ICON.sm} aria-hidden="true" className="shrink-0 text-danger" />
        <span className="text-clamp-2 grow type-xs text-danger" title={errorDetail ?? undefined} data-testid="player-error-message">
          {error}
        </span>
        {retryButton}
        {dismissButton}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={`playback-error-panel row gap-3 items-start px-5 py-2 bg-surface-2 border-t-subtle border-b-subtle ${className}`}
      data-testid="player-error"
    >
      <AlertTriangle size={ICON.sm} aria-hidden="true" className="shrink-0 text-danger playback-error-icon" />
      <div className="stack gap-px grow">
        <span
          className="text-truncate type-sm text-danger"
          // Фраза — для человека; исходное сообщение — во всплывающей подсказке,
          // чтобы код ответа и id видео были в одном наведении.
          title={errorDetail ?? undefined}
          data-testid="player-error-message"
        >
          {error}
        </span>
        {attempts && (
          <span className="text-truncate type-xs text-muted" data-testid="player-error-attempts">
            {attempts}
          </span>
        )}
      </div>
      <div className="row gap-1 shrink-0">
        {retryButton}
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void sendReport()}
          disabled={report !== 'idle'}
          icon={<Send size={ICON.xs} aria-hidden="true" />}
          title="Отправить текст ошибки, причину и id трека разработчику"
          data-testid="player-error-report"
        >
          {report === 'sent' ? 'Отчёт отправлен' : report === 'sending' ? 'Отправляем…' : 'Отправить отчёт'}
        </Button>
        {dismissButton}
      </div>
    </div>
  );
};
