import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './Button';
import { useDismissable } from '../../hooks/useDismissable';
import { ICON } from '../../styles/icons';
import { EXIT_MS } from '../../styles/motion';
import { readExitMs } from '../../services/designService';
import '../../styles/overlays.css';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string;
  className?: string;
  /** Hides the header close button; Escape and the backdrop still dismiss. */
  hideCloseButton?: boolean;
  /** Extra description text announced with the dialog. */
  description?: React.ReactNode;
  'data-testid'?: string;
}

let modalIdCounter = 0;

/**
 * The one modal primitive: `--surface-4` panel over a scrim, Escape/backdrop
 * dismissal, focus trap and focus restore (all from `useDismissable`).
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth = '520px',
  className = '',
  hideCloseButton = false,
  description,
  'data-testid': testId = 'modal-container'
}) => {
  const idRef = React.useRef<string>();
  if (!idRef.current) {
    modalIdCounter += 1;
    idRef.current = `wireon-modal-${modalIdCounter}`;
  }

  const titleId = `${idRef.current}-title`;
  const descriptionId = `${idRef.current}-description`;

  const { containerRef, backdropProps } = useDismissable<HTMLDivElement>({
    isOpen,
    onDismiss: onClose
  });

  /*
   * Окно закрывается не мгновенно: `isOpen` уже `false`, а разметка ещё в
   * дереве, пока играют кадры ухода. До этого окно исчезало между кадрами —
   * появлялось плавно, а пропадало рывком, и вместе с ним рывком возвращалось
   * всё, что было под затемнением.
   *
   * Состояние отдельное, а не производное от `isOpen`: узнать, что окно только
   * что было открыто, из одного пропа нельзя, а показывать анимацию ухода при
   * первом рендере закрытого окна — значит мигать затемнением на старте.
   */
  const [isLeaving, setIsLeaving] = React.useState(false);
  const wasOpen = React.useRef(isOpen);

  React.useEffect(() => {
    if (isOpen) {
      setIsLeaving(false);
      wasOpen.current = true;
      return;
    }

    if (!wasOpen.current) return;
    wasOpen.current = false;
    setIsLeaving(true);
    // Длительность читается в момент закрытия, а не берётся константой: пресет и
    // ручка «Движение» меняют `--dur-fast`, и снимать слой раньше или позже, чем
    // доиграли кадры, значит либо обрубить уход, либо оставить призрак висеть.
    const timer = window.setTimeout(() => setIsLeaving(false), readExitMs(EXIT_MS));
    return () => clearTimeout(timer);
  }, [isOpen]);

  if (!isOpen && !isLeaving) return null;

  /*
   * Уходящий слой — уже не окно, а его догорающее изображение. Всё, что делает
   * его окном, с него снимается: он спрятан от вспомогательных технологий,
   * выключен из порядка обхода клавиатурой и не принимает нажатия. Иначе эти
   * сто пятьдесят миллисекунд остаются полноценным диалогом — по нему можно
   * попасть табом, его читает скринридер, а клик приходится в то, чего через
   * миг не будет, вместо того, что под ним.
   */
  const ghostProps = isLeaving
    ? ({ 'aria-hidden': 'true', inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>)
    : {};

  return createPortal(
    <div
      className={`wireon-modal-backdrop ${isLeaving ? 'animate-fade-out' : 'animate-fade-in'}`}
      {...backdropProps}
      {...ghostProps}
      onClick={(event) => {
        event.stopPropagation();
        backdropProps.onClick(event);
      }}
      style={
        {
          position: 'fixed',
          inset: 0,
          backgroundColor: 'var(--scrim)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 'var(--z-modal)',
          padding: 'calc(var(--safe-top) + var(--overlay-gutter)) calc(var(--safe-right) + var(--overlay-gutter)) calc(var(--safe-bottom) + var(--overlay-gutter)) calc(var(--safe-left) + var(--overlay-gutter))',
          pointerEvents: isLeaving ? 'none' : 'auto'
        } as React.CSSProperties
      }
      data-testid="modal-backdrop"
      data-leaving={isLeaving || undefined}
    >
      <div
        ref={containerRef}
        role={isLeaving ? undefined : 'dialog'}
        aria-modal={isLeaving ? undefined : 'true'}
        aria-labelledby={title && !isLeaving ? titleId : undefined}
        aria-describedby={description && !isLeaving ? descriptionId : undefined}
        /*
         * Вход пружиной от центра, а не подъёмом снизу: уход у окна — `popOut`,
         * то есть сжатие к центру. Подъём ему не парный, окно приезжало снизу,
         * а уезжало «в себя». `dropIn` начинается ровно там, где `popOut`
         * заканчивается (scale .96), поэтому открытие и закрытие стали одним
         * движением в две стороны. Плюс `dropIn` удерживает первый кадр
         * (`both`), а `slideUp` — нет: панель успевала мелькнуть готовой.
         */
        className={`wireon-modal-panel ${isLeaving ? 'animate-pop-out' : 'animate-drop-in'}${className ? ` ${className}` : ''}`}
        style={{
          width: '100%',
          minWidth: 0,
          maxWidth,
          /* Точка роста — середина панели: значение по умолчанию у примитива —
           * верхний край, и оно про меню, выпадающее из-под своей кнопки. У окна
           * посреди экрана такой кнопки нет. */
          '--pop-origin': 'center',
          backgroundColor: 'var(--surface-4)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 'calc(var(--app-height) - var(--safe-top) - var(--safe-bottom) - var(--overlay-gutter) * 2)',
          '--ring-offset-color': 'var(--surface-4)'
        } as React.CSSProperties}
        data-testid={testId}
      >
        {(title || !hideCloseButton) && (
          <div
            className="wireon-modal-header"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-4)',
              padding: 'var(--space-4) var(--overlay-content-padding)',
              flexShrink: 0,
              borderBottom: '1px solid var(--border-subtle)'
            }}
          >
            <h3
              id={titleId}
              style={{
                fontSize: 'var(--text-lg)',
                lineHeight: 'var(--leading-lg)',
                letterSpacing: 'var(--tracking-lg)',
                fontWeight: 'var(--weight-semibold)',
                color: 'var(--text-primary)',
                margin: 0,
                minWidth: 0,
                overflowWrap: 'anywhere'
              }}
            >
              {title}
            </h3>
            {!hideCloseButton && (
              <Button
                variant="icon"
                onClick={onClose}
                aria-label="Закрыть окно"
                style={{ width: '44px', height: '44px', flexShrink: 0 }}
                data-testid="modal-close-btn"
              >
                <X size={ICON.md} />
              </Button>
            )}
          </div>
        )}

        <div
          className="wireon-modal-content scrollbar-thin"
          style={{ padding: 'var(--overlay-content-padding)', overflowY: 'auto', flex: 1, minHeight: 0, minWidth: 0, overscrollBehavior: 'contain', overflowWrap: 'anywhere' }}
        >
          {description && (
            <p
              id={descriptionId}
              style={{
                margin: '0 0 var(--space-4) 0',
                fontSize: 'var(--text-sm)',
                lineHeight: 'var(--leading-sm)',
                color: 'var(--text-secondary)'
              }}
            >
              {description}
            </p>
          )}
          {children}
        </div>

        {footer && (
          <div
            className="wireon-modal-footer"
            style={{
              padding: 'var(--space-4) var(--overlay-content-padding)',
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              flexWrap: 'wrap',
              flexShrink: 0,
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 'var(--space-3)'
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
