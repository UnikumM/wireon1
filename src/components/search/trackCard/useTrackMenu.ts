import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Где стоит меню на экране: считается от кнопки, а не от строки списка. */
export interface TrackMenuPosition {
  top: number;
  left: number;
  origin: string;
}

export interface TrackMenu {
  isOpen: boolean;
  position: TrackMenuPosition | null;
  /** Обёртка кнопки «ещё» — по ней считается «клик снаружи» и ходит фокус по пунктам. */
  rootRef: React.RefObject<HTMLDivElement>;
  triggerRef: React.RefObject<HTMLButtonElement>;
  /** Сама панель в портале: прокрутка внутри неё меню не закрывает. */
  panelRef: React.RefObject<HTMLDivElement>;
  toggle: () => void;
  /** `restoreFocus: false` — когда фокус уйдёт в другое место сам (режим выбора). */
  close: (restoreFocus?: boolean) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

/**
 * Состояние выпадающего меню трека: открыто/закрыто, место на экране,
 * закрытие по клику мимо, Escape, прокрутке и смене размера, ходьба по
 * пунктам стрелками.
 *
 * Вынесено из карточки, чтобы разметка меню (`TrackContextMenu`) осталась
 * чистой, а контейнер — коротким: здесь три эффекта и ни одной строки JSX.
 */
export function useTrackMenu(): TrackMenu {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<TrackMenuPosition | null>(null);

  const closeMenu = useCallback((restoreFocus = true) => {
    setIsMenuOpen(false);
    if (restoreFocus) menuTriggerRef.current?.focus();
  }, []);

  const toggle = useCallback(() => setIsMenuOpen((open) => !open), []);

  // Dismiss the context menu on outside click / Escape, and move focus back to
  // the trigger so keyboard users are not stranded.
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || menuPanelRef.current?.contains(target)) return;
      setIsMenuOpen(false);
    };
    // Меню приколото к экрану: при прокрутке списка оно осталось бы висеть
    // над чужой строкой, поэтому прокрутка и смена размера окна его закрывают.
    const handleScroll = (e: Event) => {
      // Прокрутка самого меню (длинный список) его не закрывает.
      if (e.target instanceof Node && menuPanelRef.current?.contains(e.target)) return;
      setIsMenuOpen(false);
    };
    const handleResize = () => setIsMenuOpen(false);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenu();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [isMenuOpen, closeMenu]);

  /*
   * Меню живёт на уровне экрана (портал в body), а не внутри строки.
   *
   * Раньше оно было абсолютным потомком строки и всегда раскрывалось вниз: у
   * нижних треков списка оно уезжало под полосу плеера и за край прокрутки, а
   * у виртуализированных списков ещё и пряталось вместе со строкой. Теперь
   * место считается от кнопки: вниз, если помещается над полосой плеера, иначе
   * вверх; по горизонтали — не дальше краёв окна.
   */
  useLayoutEffect(() => {
    if (!isMenuOpen) {
      setMenuPosition(null);
      return;
    }
    const trigger = menuTriggerRef.current;
    const panel = menuPanelRef.current;
    if (!trigger || typeof window === 'undefined') return;
    const rect = trigger.getBoundingClientRect();
    const width = panel?.offsetWidth || 220;
    const height = panel?.offsetHeight || 320;
    const gap = 4;
    const margin = 8;
    const bar = document.querySelector<HTMLElement>('[data-testid="player-bar"]');
    const bottomLimit = Math.min(window.innerHeight, bar ? bar.getBoundingClientRect().top : window.innerHeight) - margin;
    const fitsBelow = rect.bottom + gap + height <= bottomLimit;
    const top = fitsBelow ? rect.bottom + gap : Math.max(margin, rect.top - gap - height);
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
    setMenuPosition({ top, left, origin: fitsBelow ? 'top right' : 'bottom right' });
  }, [isMenuOpen]);

  /** Roving focus inside the context menu. */
  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ' || e.key === 'Spacebar') {
      // Space has to activate the item here; the global play/pause shortcut
      // would otherwise swallow it before the button ever fires.
      const item = (e.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]');
      if (!item) return;
      e.preventDefault();
      item.click();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []
    );
    if (items.length === 0) return;
    e.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    const from = items.findIndex((item) => item === active);
    let next = 0;
    if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = from < 0 ? 0 : (from + 1) % items.length;
    else if (e.key === 'ArrowUp') next = from < 0 ? items.length - 1 : (from - 1 + items.length) % items.length;
    items[next].focus();
  };

  return {
    isOpen: isMenuOpen,
    position: menuPosition,
    rootRef: menuRef,
    triggerRef: menuTriggerRef,
    panelRef: menuPanelRef,
    toggle,
    close: closeMenu,
    onKeyDown: handleMenuKeyDown,
  };
}
