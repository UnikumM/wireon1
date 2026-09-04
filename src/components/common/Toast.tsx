import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Check, Info, X } from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';
import { ToastInfo } from '../../types/store';
import { ICON } from '../../styles/icons';
import { EXIT_MS } from '../../styles/motion';
import { readExitMs } from '../../services/designService';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

const AUTO_DISMISS_MS = 4500;

interface ToastEntry {
  key: string;
  text: string;
  variant: ToastVariant;
  /** Уже уходит: карточка ещё в дереве, но доигрывает кадры. */
  isLeaving?: boolean;
}

const VARIANT_TOKENS: Record<ToastVariant, { color: string; soft: string }> = {
  info: { color: 'var(--info)', soft: 'var(--info-soft)' },
  success: { color: 'var(--success)', soft: 'var(--success-soft)' },
  warning: { color: 'var(--warning)', soft: 'var(--warning-soft)' },
  error: { color: 'var(--danger)', soft: 'var(--danger-soft)' }
};

function variantIcon(variant: ToastVariant): React.ReactNode {
  const style = { color: VARIANT_TOKENS[variant].color, flexShrink: 0 };
  switch (variant) {
    case 'success':
      return <Check size={ICON.md} style={style} aria-hidden="true" />;
    case 'warning':
      return <AlertTriangle size={ICON.md} style={style} aria-hidden="true" />;
    case 'error':
      return <AlertCircle size={ICON.md} style={style} aria-hidden="true" />;
    case 'info':
    default:
      return <Info size={ICON.md} style={style} aria-hidden="true" />;
  }
}

/**
 * `useUIStore` holds one toast at a time, so a burst of messages would previously
 * overwrite each other before they could be read. This keeps a short local stack
 * and drains it on its own timers.
 */
function useToastStack(): { toasts: ToastEntry[]; dismiss: (key: string) => void } {
  const toastMessage = useUIStore((s) => s.toastMessage);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const lastSeen = useRef<ToastInfo | null>(null);
  // Таймеры ухода живут дольше, чем сама карточка, поэтому их владелец — область
  // уведомлений: при размонтировании их нужно снять, иначе они добудятся до
  // состояния, которого уже нет.
  const exitTimers = useRef<number[]>([]);

  useEffect(() => () => exitTimers.current.forEach((id) => clearTimeout(id)), []);

  useEffect(() => {
    if (!toastMessage || toastMessage === lastSeen.current) return;
    lastSeen.current = toastMessage;

    const key = toastMessage.id ?? `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const entry: ToastEntry = {
      key,
      text: toastMessage.text,
      variant: (toastMessage.type as ToastVariant) ?? 'info'
    };

    setToasts((current) => [...current.slice(-3), entry]);
  }, [toastMessage]);

  const dismiss = useCallback((key: string) => {
    // Сначала помечаем уходящей, снимаем из дерева — когда доиграют кадры.
    // Мгновенное исчезновение читалось как сбой отрисовки: сообщение приезжало
    // плавно, а пропадало между кадрами. Длительность спрашиваем у документа:
    // пресет и ручка «Движение» её меняют, а константа осталась бы прежней.
    setToasts((current) => current.map((t) => (t.key === key ? { ...t, isLeaving: true } : t)));

    // Хранилище чистим сразу, не дожидаясь кадров: пока в нём лежит это
    // сообщение, повтор того же текста будет принят за дубликат и не покажется.
    if (useUIStore.getState().toastMessage?.id === key) {
      useUIStore.getState().clearToast();
    }

    const timer = window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.key !== key));
      exitTimers.current = exitTimers.current.filter((id) => id !== timer);
    }, readExitMs(EXIT_MS));
    exitTimers.current.push(timer);
  }, []);

  return { toasts, dismiss };
}

interface ToastCardProps {
  entry: ToastEntry;
  onDismiss: (key: string) => void;
}

const ToastCard: React.FC<ToastCardProps> = ({ entry, onDismiss }) => {
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    // Уходящую карточку будить своим таймером незачем: решение уже принято.
    if (isPaused || entry.isLeaving) return;
    const timer = setTimeout(() => onDismiss(entry.key), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [entry.key, entry.isLeaving, isPaused, onDismiss]);

  const tokens = VARIANT_TOKENS[entry.variant];

  return (
    <div
      className={`panel-raised ${entry.isLeaving ? 'animate-slide-out' : 'animate-slide-up'}`}
      role={entry.variant === 'error' ? 'alert' : 'status'}
      aria-live={entry.variant === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        maxWidth: '380px',
        // Уходящая карточка нажатия больше не принимает: щёлкнуть по крестику,
        // которого через миг не будет, — верный способ промахнуться по тому,
        // что под ним.
        pointerEvents: entry.isLeaving ? 'none' : 'auto'
      }}
      data-testid="toast-notification"
      data-variant={entry.variant}
      data-leaving={entry.isLeaving || undefined}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '26px',
          height: '26px',
          borderRadius: 'var(--radius-full)',
          backgroundColor: tokens.soft,
          flexShrink: 0
        }}
      >
        {variantIcon(entry.variant)}
      </span>

      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 'var(--text-sm)',
          lineHeight: 'var(--leading-sm)',
          color: 'var(--text-primary)'
        }}
      >
        {entry.text}
      </span>

      <button
        type="button"
        className="press"
        onClick={() => onDismiss(entry.key)}
        aria-label="Закрыть уведомление"
        style={{
          color: 'var(--text-muted)',
          width: '24px',
          height: '24px',
          borderRadius: 'var(--radius-xs)',
          flexShrink: 0
        }}
      >
        <X size={ICON.sm} />
      </button>
    </div>
  );
};

/** The single toast region. Mounted once by `AppShell`. */
export const Toast: React.FC = () => {
  const { toasts, dismiss } = useToastStack();

  if (toasts.length === 0) return null;

  return (
    <div
      style={
        {
          position: 'fixed',
          // Над полосой плеера, а на узком экране — ещё и над нижней
          // навигацией с полосой жеста: иначе сообщение о неудаче прячется
          // ровно за тем, что человек в этот момент и нажимает.
          bottom:
            'calc(var(--player-bar-space) + var(--mobile-nav-height) + var(--safe-bottom) + var(--space-4))',
          right: 'var(--space-5)',
          zIndex: 'var(--z-toast)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 'var(--space-2)',
          pointerEvents: 'none'
        } as React.CSSProperties
      }
      data-testid="toast-region"
    >
      {toasts.map((entry) => (
        <ToastCard key={entry.key} entry={entry} onDismiss={dismiss} />
      ))}
    </div>
  );
};
