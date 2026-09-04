import React from 'react';
import { useDismissable } from '../../hooks/useDismissable';
import { useSwipeDismiss } from '../../hooks/useSwipeDismiss';

/**
 * Лист снизу — способ показать что-то поверх экрана на телефоне.
 *
 * Почему не модалка по центру. Модалка родилась для мыши: она появляется там,
 * куда смотрят, и закрывается крестиком в углу. На телефоне смотрят в середину,
 * а достают — до низа, и угол экрана оказывается самой неудобной точкой для
 * большого пальца. Лист приходит оттуда, откуда до него дотягиваются, и уходит
 * тем же движением, которым его прогоняют.
 *
 * Что этот примитив чинит по сравнению с тем, что было. Меню трека жило
 * `position: absolute` внутри прокручиваемого `<main>` и потому **обрезалось
 * контейнером** — `z-index: 1000` там не помогает, слой заперт. Плюс оно всегда
 * открывалось вниз, без переворота, и на нижней половине экрана уезжало под
 * полосу плеера. Лист таких мест не имеет вовсе: он прибит к окну (`fixed`), а
 * не к строке, и всегда растёт вверх от нижнего края.
 *
 * Высота считается от `--app-height`, а не от `100vh`: на телефоне адресная
 * строка то есть, то нет, и `100vh` больше настоящего экрана — низ листа
 * оказался бы под краем. Нижний отступ включает `--safe-bottom`, иначе
 * последний пункт попадает под полосу жестов.
 */

export interface SheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** Заголовок листа. Без него шапка не рисуется вовсе. */
  title?: string;
  /** Своя шапка вместо заголовка — например, обложка с названием трека. */
  header?: React.ReactNode;
  children: React.ReactNode;
  /**
   * Доля высоты экрана, выше которой лист не растёт. По умолчанию 0.85 — верх
   * остаётся видимым, и понятно, что под листом осталось приложение.
   */
  maxHeightRatio?: number;
  'data-testid'?: string;
  'aria-label'?: string;
}

export const Sheet: React.FC<SheetProps> = ({
  isOpen,
  onClose,
  title,
  header,
  children,
  maxHeightRatio = 0.85,
  'data-testid': testId,
  'aria-label': ariaLabel
}) => {
  const { containerRef, backdropProps } = useDismissable<HTMLDivElement>({
    isOpen,
    onDismiss: onClose
  });

  const { offset, isDragging, isClosing, handlers } = useSwipeDismiss({
    enabled: isOpen,
    onDismiss: onClose
  });

  if (!isOpen) return null;

  const titleId = title ? `${testId ?? 'sheet'}-title` : undefined;

  return (
    <div
      className="animate-fade-in"
      style={
        {
          position: 'fixed',
          inset: 0,
          zIndex: 'var(--z-modal)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          backgroundColor: 'var(--scrim)'
        } as React.CSSProperties
      }
      {...backdropProps}
      data-testid={testId ? `${testId}-overlay` : undefined}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : ariaLabel}
        className="animate-sheet-up"
        style={{
          maxHeight: `calc(var(--app-height) * ${maxHeightRatio})`,
          width: '100%',
          background: 'var(--surface-3)',
          borderTop: '1px solid var(--border)',
          borderTopLeftRadius: 'var(--radius-xl)',
          borderTopRightRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-lg), var(--highlight-top)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          // Лист едет за пальцем один к одному; во время перетаскивания
          // переход выключен, иначе он тянулся бы следом с задержкой.
          transform: offset > 0 ? `translate3d(0, ${offset}px, 0)` : undefined,
          transition: isDragging ? 'none' : undefined,
          touchAction: 'none'
        }}
        data-testid={testId}
        data-closing={isClosing ? 'true' : undefined}
        {...handlers}
      >
        {/*
          * Полоска-ухватка. Не орган управления, а подпись: она сообщает, что
          * лист можно смахнуть, до того как человек это попробует.
          */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            paddingTop: 'var(--space-3)',
            paddingBottom: header || title ? 0 : 'var(--space-2)',
            flexShrink: 0
          }}
        >
          <div
            data-testid="sheet-grabber"
            aria-hidden="true"
            style={{
              width: '36px',
              height: '4px',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--border-strong)'
            }}
          />
        </div>

        {header ? (
          <div style={{ flexShrink: 0, padding: 'var(--space-4) var(--space-4) var(--space-2)' }}>{header}</div>
        ) : title ? (
          <h2
            id={titleId}
            style={{
              flexShrink: 0,
              margin: 0,
              padding: 'var(--space-4) var(--space-4) var(--space-2)',
              fontSize: 'var(--text-lg)',
              lineHeight: 'var(--leading-lg)',
              letterSpacing: 'var(--tracking-lg)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)'
            }}
          >
            {title}
          </h2>
        ) : null}

        {/*
          * Прокручивается только содержимое: ухватка и шапка остаются на месте,
          * иначе жест закрытия и прокрутка списка ловили бы одно движение.
          */}
        <div
          className="scrollbar-thin"
          style={{
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            paddingBottom: 'calc(max(var(--safe-bottom), var(--space-2)) + var(--space-2))',
            touchAction: 'pan-y'
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};

export interface SheetRowProps {
  icon: React.ReactNode;
  label: string;
  /** Пояснение под подписью — для пунктов, смысл которых не читается из названия. */
  hint?: string;
  onClick: () => void;
  /** Опасное действие красится в `--danger`. */
  danger?: boolean;
  /** Пункт, ведущий в следующий лист, получает стрелку вместо тишины. */
  chevron?: React.ReactNode;
  'data-testid'?: string;
}

/**
 * Строка внутри листа.
 *
 * Высота 56 px — не «покрупнее для красоты», а нижняя граница, при которой в
 * строку попадают пальцем не глядя. Прежнее меню давало пункты по 34 px и
 * кнопку вызова 32×32: в такое целятся, а не нажимают.
 */
export const SheetRow: React.FC<SheetRowProps> = ({
  icon,
  label,
  hint,
  onClick,
  danger = false,
  chevron,
  'data-testid': testId
}) => (
  <button
    type="button"
    className="menu-item-hover press"
    onClick={onClick}
    data-testid={testId}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-4)',
      width: '100%',
      minHeight: '56px',
      padding: 'var(--space-2) var(--space-4)',
      color: danger ? 'var(--danger)' : 'var(--text-primary)',
      textAlign: 'left',
      cursor: 'pointer'
    }}
  >
    <span style={{ display: 'flex', flexShrink: 0, color: danger ? 'var(--danger)' : 'var(--text-secondary)' }}>
      {icon}
    </span>
    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: '2px' }}>
      <span
        className="text-truncate"
        style={{
          fontSize: 'var(--text-base)',
          lineHeight: 'var(--leading-base)',
          letterSpacing: 'var(--tracking-base)'
        }}
      >
        {label}
      </span>
      {hint && (
        <span
          className="text-truncate"
          style={{
            fontSize: 'var(--text-sm)',
            lineHeight: 'var(--leading-sm)',
            letterSpacing: 'var(--tracking-sm)',
            color: 'var(--text-muted)'
          }}
        >
          {hint}
        </span>
      )}
    </span>
    {chevron && <span style={{ display: 'flex', flexShrink: 0, color: 'var(--text-faint)' }}>{chevron}</span>}
  </button>
);
