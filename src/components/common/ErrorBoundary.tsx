import React from 'react';
import { AlertTriangle, ClipboardCopy, RotateCcw, RotateCw } from 'lucide-react';
import { Button } from './Button';
import { buildErrorReport } from '../../utils/appInfo';
import { ICON } from '../../styles/icons';

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Replaces the default fallback card entirely. */
  fallback?: React.ReactNode;
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
  /** Result of the last "copy report" attempt, shown next to the button. */
  copyState: 'idle' | 'copied' | 'failed';
}

/**
 * Catches render-time errors so a single broken view cannot blank the whole
 * window. The stack is only shown in a dev build, but it always goes into the
 * copyable report — that is the whole point of the report.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = { error: null, componentStack: null, copyState: 'idle' };

  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  public componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error('[ErrorBoundary] Uncaught render error:', error);
    this.props.onError?.(error, info);
  }

  /** Re-mounts the subtree. Playback survives this; a reload does not. */
  private handleRetry = (): void => {
    this.setState({ error: null, componentStack: null, copyState: 'idle' });
  };

  private handleReload = (): void => {
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    } else {
      this.handleRetry();
    }
  };

  private handleCopyReport = async (): Promise<void> => {
    const { error, componentStack } = this.state;
    if (!error) return;

    const report = buildErrorReport({
      message: error.message,
      stack: error.stack,
      componentStack
    });

    try {
      const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (!clipboard?.writeText) throw new Error('clipboard unavailable');
      await clipboard.writeText(report);
      this.setState({ copyState: 'copied' });
    } catch {
      // Печатаем отчёт в консоль: раз скопировать нельзя, пусть его хотя бы
      // можно будет достать оттуда.
      console.error('[ErrorBoundary] Отчёт не скопировался, вот он целиком:\n' + report);
      this.setState({ copyState: 'failed' });
    }
  };

  public render(): React.ReactNode {
    const { error, componentStack, copyState } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    const isDev = import.meta.env.DEV;

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100%',
          padding: 'var(--space-6)',
          backgroundColor: 'var(--bg-base)'
        }}
        data-testid="error-boundary-fallback"
      >
        <div
          className="card"
          style={{
            maxWidth: '560px',
            width: '100%',
            padding: 'var(--space-5)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <AlertTriangle size={ICON.lg} aria-hidden="true" style={{ color: 'var(--danger)', flexShrink: 0 }} />
            <h2
              style={{
                margin: 0,
                fontSize: 'var(--text-xl)',
                lineHeight: 'var(--leading-xl)',
                letterSpacing: 'var(--tracking-xl)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)'
              }}
            >
              Что-то сломалось при отрисовке
            </h2>
          </div>

          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-sm)',
              lineHeight: 'var(--leading-sm)',
              color: 'var(--text-secondary)'
            }}
            data-testid="error-boundary-message"
          >
            {error.message || 'Неизвестная ошибка.'}
          </p>

          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-xs)',
              lineHeight: 'var(--leading-xs)',
              color: 'var(--text-muted)'
            }}
          >
            «Попробовать снова» перерисовывает только этот экран — музыка не
            прервётся. Отчёт содержит версию, среду и стек; ни токена, ни ваших
            треков в нём нет.
          </p>

          {isDev && componentStack && (
            <details
              className="panel-inset"
              style={{ padding: 'var(--space-3)', borderRadius: 'var(--radius-sm)' }}
            >
              <summary
                style={{
                  cursor: 'pointer',
                  fontSize: 'var(--text-sm)',
                  color: 'var(--text-muted)'
                }}
              >
                Стек компонентов
              </summary>
              <pre
                className="scrollbar-thin"
                style={{
                  margin: 'var(--space-2) 0 0 0',
                  maxHeight: '220px',
                  overflow: 'auto',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-xs)',
                  lineHeight: 'var(--leading-xs)',
                  color: 'var(--text-muted)',
                  whiteSpace: 'pre-wrap'
                }}
              >
                {componentStack.trim()}
              </pre>
            </details>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 'var(--space-2)',
              flexWrap: 'wrap'
            }}
          >
            {copyState !== 'idle' && (
              <span
                role="status"
                style={{
                  marginRight: 'auto',
                  fontSize: 'var(--text-xs)',
                  lineHeight: 'var(--leading-xs)',
                  color: copyState === 'copied' ? 'var(--success)' : 'var(--danger)'
                }}
                data-testid="error-boundary-copy-state"
              >
                {copyState === 'copied'
                  ? 'Отчёт скопирован в буфер обмена.'
                  : 'Буфер обмена недоступен — отчёт целиком выведен в консоль.'}
              </span>
            )}

            <Button
              variant="secondary"
              icon={<ClipboardCopy size={ICON.md} />}
              onClick={() => void this.handleCopyReport()}
              data-testid="error-boundary-copy"
            >
              Скопировать отчёт
            </Button>
            <Button
              variant="secondary"
              icon={<RotateCw size={ICON.md} />}
              onClick={this.handleRetry}
              data-testid="error-boundary-retry"
            >
              Попробовать снова
            </Button>
            <Button
              variant="primary"
              icon={<RotateCcw size={ICON.md} />}
              onClick={this.handleReload}
              data-testid="error-boundary-reload"
            >
              Перезагрузить
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
