/**
 * Системная кнопка (и жест) «назад» на Android.
 *
 * Без своего обработчика Capacitor на «назад» просто закрывает приложение:
 * истории страниц у одностраничного приложения нет. Из плейлиста это выглядело
 * как «кнопки назад нет»: нажал — приложение пропало, музыка замолчала.
 *
 * Один нажим — один слой, сверху вниз:
 *
 * 1. верхний открытый слой (окно, лист, меню, очередь, текст, сцена плеера) —
 *    тем же путём, каким его закрывает Escape (`dismissTopOverlay`), поэтому
 *    новый слой на `useDismissable` попадает сюда сам, без правки этого файла;
 * 2. то, что на общий стек не опирается: лист действий трека, окно «Теги и
 *    заметка», «Итоги», режим выбора треков;
 * 3. экран: с вложенного — туда, откуда пришли (`useUIStore.goBack`), с любого
 *    раздела — на «Главную»;
 * 4. «Главная» — приложение сворачивается, а не закрывается: музыка играет дальше.
 */

import { dismissTopOverlay } from '../hooks/useDismissable';
import { useUIStore } from '../store/useUIStore';
import { detectPlatform } from './nativeBridge';

export type BackOutcome = 'layer' | 'view' | 'minimize';

/** Что сделало нажатие «назад». Чистая логика поверх сторов — её и проверяют тесты. */
export function handleBackPress(): BackOutcome {
  if (dismissTopOverlay()) return 'layer';

  const ui = useUIStore.getState();
  if (ui.actionsTrack) {
    ui.closeTrackActions();
    return 'layer';
  }
  if (ui.notesTrack) {
    ui.closeTrackNotes();
    return 'layer';
  }
  if (ui.recapPeriod) {
    ui.closeRecap();
    return 'layer';
  }
  if (ui.isCommandPaletteOpen) {
    ui.setCommandPaletteOpen(false);
    return 'layer';
  }
  if (ui.isFullscreenPlayerOpen) {
    ui.setFullscreenPlayerOpen(false);
    return 'layer';
  }
  if (ui.isQueueOpen) {
    ui.setQueueOpen(false);
    return 'layer';
  }
  if (ui.isLyricsOpen) {
    ui.setLyricsOpen(false);
    return 'layer';
  }
  if (ui.selectedTrackIds && ui.selectedTrackIds.length > 0) {
    ui.clearSelection();
    return 'layer';
  }

  return ui.goBack() ? 'view' : 'minimize';
}

let started: Promise<() => void> | null = null;

/**
 * Подписка на «назад». Вызывается один раз при запуске; вне телефона — пустышка:
 * на ПК кнопки нет, а плагин вне нативной оболочки бросает исключение.
 */
export function startBackButton(): Promise<() => void> {
  if (started) return started;
  started = (async () => {
    if (detectPlatform() !== 'mobile') return () => {};

    let App: any;
    try {
      App = (await import('@capacitor/app')).App;
    } catch {
      return () => {};
    }
    if (!App?.addListener) return () => {};

    let cancelled = false;
    let handle: any = null;
    void App.addListener('backButton', () => {
      if (cancelled) return;
      if (handleBackPress() === 'minimize') {
        // Свернуть, а не выйти: `exitApp` убил бы и воспроизведение.
        void App.minimizeApp?.();
      }
    }).then((registered: any) => {
      handle = registered;
      if (cancelled) void handle?.remove?.();
    });

    return () => {
      cancelled = true;
      void handle?.remove?.();
    };
  })();
  return started;
}

/** Забыть подписку — между проверками. */
export function resetBackButtonForTests(): void {
  started = null;
}
