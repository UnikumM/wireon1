import { useEffect } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useUIStore } from '../store/useUIStore';
import { recommendationEngine } from '../services/recommendationEngine';
import { getOpenOverlayCount } from './useDismissable';

const SEEK_STEP_SECONDS = 5;

/** Keys the user is typing into must never be stolen. */
/**
 * Элементы, которым клавиши нужны самим.
 *
 * Отсюда растёт жалоба «бинды работают не на всех экранах». Сочетания слушает
 * одно окно, а списки треков, вкладки медиатеки и караоке забирают стрелки и
 * пробел под свою навигацию — и делают это через `preventDefault`. Обработчик
 * стоял после них и видел уже погашенное событие, поэтому на этих экранах
 * молчал целиком, даже там, где список ничего не перехватывал.
 *
 * Теперь наоборот: слушаем в фазе перехвата, до всех, но уступаем, когда
 * клавиша адресована конкретному элементу под курсором. Кнопке нужен пробел,
 * строке списка — стрелки, ползунку — обе; всё остальное на экране клавиш не
 * ждёт, и там работает плеер.
 */
const CONTROL_KEYS = new Set([
  ' ',
  'Spacebar',
  'Enter',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown'
]);

function isFromInteractiveControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.closest(
      'button, a[href], select, input[type="range"], input[type="checkbox"], input[type="radio"], [role="button"], [role="tab"], [role="option"], [role="row"], [role="slider"], [role="menuitem"], [role="listbox"], [tabindex]:not([tabindex="-1"])'
    ) !== null
  );
}

/** Поля, куда человек печатает. Ползунок и флажок сюда не относятся. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week'
]);

function isTextInput(element: HTMLElement): boolean {
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;
  const type = (element as HTMLInputElement).type || 'text';
  return TEXT_INPUT_TYPES.has(type);
}

/**
 * Клавиша адресована полю ввода, а не плееру.
 *
 * Раньше сюда попадал любой `input`, включая ползунки громкости и перемотки.
 * Из-за этого после щелчка по полосе трека приложение переставало слышать
 * клавиши вовсе: `M` не выключал звук, потому что фокус «печатал» в ползунок.
 * Печатают только в текстовые поля — их и проверяем.
 */
function isFromTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  // Сначала редактируемая область: `isContentEditable` есть не везде (в тестовой
  // среде его нет вовсе), поэтому опираемся на сам атрибут.
  if (target.isContentEditable) return true;
  if (target.closest('[contenteditable=""], [contenteditable="true"]')) return true;

  const field = target.closest('input, textarea');
  return field instanceof HTMLElement ? isTextInput(field) : false;
}

/**
 * The single global shortcut listener. Keys with no modifier only fire when no
 * modifier is held, so `Ctrl+F`, `Alt+Q` and friends still reach the browser and
 * the OS.
 */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isFromTextEntry(event.target)) return;
      // Уступаем только те клавиши, которыми элемент под фокусом реально
      // управляется. Раньше уступали все подряд, и после щелчка по кнопке или
      // ползунку переставало работать вообще всё, включая `M`.
      if (CONTROL_KEYS.has(event.key) && isFromInteractiveControl(event.target)) return;

      const player = usePlayerStore.getState();
      const ui = useUIStore.getState();
      const isMod = event.ctrlKey || event.metaKey;

      // Command palette is the only chorded shortcut with Ctrl/Cmd.
      if (isMod && !event.altKey && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        ui.toggleCommandPalette();
        return;
      }

      // Alt+W / KeyW: Navigate to «Поток» tab or toggle Wave playback
      if (event.altKey && !isMod && !event.shiftKey && (event.key === 'w' || event.key === 'W' || event.code === 'KeyW')) {
        event.preventDefault();
        if (ui.activeView !== 'wave') {
          ui.setActiveView('wave');
          if (player.queueMode !== 'my_wave') {
            void player.startMyWave(ui.activeWaveMood, ui.activeWaveGenre);
          }
        } else {
          if (player.queueMode === 'my_wave' && player.currentTrack) {
            void player.togglePlayPause();
          } else {
            void player.startMyWave(ui.activeWaveMood, ui.activeWaveGenre);
          }
        }
        return;
      }

      // Alt+R: Start Track Radio on current track
      if (event.altKey && !isMod && !event.shiftKey && (event.key === 'r' || event.key === 'R' || event.code === 'KeyR')) {
        event.preventDefault();
        if (player.currentTrack) {
          void player.startTrackRadio(player.currentTrack);
          ui.showToast(`Запущено радио по треку "${player.currentTrack.title}"`, 'success');
        }
        return;
      }

      // Alt+M: Toggle Mini Player
      if (event.altKey && !isMod && !event.shiftKey && (event.key === 'm' || event.key === 'M' || event.code === 'KeyM')) {
        event.preventDefault();
        void ui.toggleMiniPlayer();
        return;
      }

      if (isMod || event.altKey) return;

      switch (event.key) {
        case ' ':
        case 'Spacebar': {
          if (event.shiftKey) return;
          // Space would otherwise scroll the view behind the player.
          event.preventDefault();
          void player.togglePlayPause();
          return;
        }

        case 'ArrowLeft': {
          event.preventDefault();
          if (event.shiftKey) {
            void player.prevTrack();
          } else {
            player.seekTo(Math.max(0, player.currentTime - SEEK_STEP_SECONDS));
          }
          return;
        }

        case 'ArrowRight': {
          event.preventDefault();
          if (event.shiftKey) {
            void player.nextTrack(true);
          } else {
            const limit = player.duration > 0 ? player.duration : player.currentTime + SEEK_STEP_SECONDS;
            player.seekTo(Math.min(limit, player.currentTime + SEEK_STEP_SECONDS));
          }
          return;
        }

        case 'm':
        case 'M': {
          if (event.shiftKey) return;
          event.preventDefault();
          player.toggleMute();
          return;
        }

        case 'f':
        case 'F': {
          if (event.shiftKey) return;
          event.preventDefault();
          ui.toggleFullscreenPlayer();
          return;
        }

        case 'q':
        case 'Q': {
          if (event.shiftKey) return;
          event.preventDefault();
          ui.toggleQueue();
          return;
        }

        case 'l':
        case 'L': {
          if (event.shiftKey) return;
          event.preventDefault();
          const current = player.currentTrack;
          if (current) {
            const lib = useLibraryStore.getState();
            const wasFav = lib.isFavorite(current.id);
            void lib.toggleFavorite(current).then((ok) => {
              if (ok) {
                if (!wasFav) {
                  void recommendationEngine.recordFeedback(current, 'like');
                  ui.showToast(`Добавлено в любимое: "${current.title}"`, 'success');
                } else {
                  ui.showToast(`Удалено из любимого: "${current.title}"`, 'info');
                }
              }
            });
          }
          return;
        }

        case 'd':
        case 'D': {
          if (event.shiftKey) return;
          event.preventDefault();
          const current = player.currentTrack;
          if (current) {
            const trackTitle = current.title;
            void player.dislikeAndSkipCurrentTrack().then(() => {
              ui.showToast(`"${trackTitle}" больше не будет рекомендоваться`, 'info');
            }).catch(() => {
              ui.showToast('Ошибка при пропуске трека', 'error');
            });
          }
          return;
        }

        case '/': {
          if (event.shiftKey) return;
          event.preventDefault();
          if (ui.activeView !== 'search') ui.setActiveView('search');
          // The field mounts with the search view, so focus on the next frame.
          requestAnimationFrame(() => {
            const input = document.querySelector<HTMLInputElement>('[data-testid="search-input"]');
            input?.focus();
            input?.select();
          });
          return;
        }

        case 'Escape': {
          // A mounted dismissable layer owns Escape and closes itself; only step
          // in for overlays that are not wired to `useDismissable`.
          if (getOpenOverlayCount() > 0) return;
          if (ui.isCommandPaletteOpen) {
            event.preventDefault();
            ui.setCommandPaletteOpen(false);
          } else if (ui.isFullscreenPlayerOpen) {
            event.preventDefault();
            ui.setFullscreenPlayerOpen(false);
          } else if (ui.isQueueOpen) {
            event.preventDefault();
            ui.setQueueOpen(false);
          }
          return;
        }

        default:
          return;
      }
    };

    // Перехват, а не всплытие: иначе экраны со своей навигацией по клавишам
    // гасят событие раньше, чем оно доходит сюда.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
