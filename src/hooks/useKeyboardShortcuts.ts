import { useEffect } from 'react';
import { usePlayerStore } from '../store/usePlayerStore';
import { useLibraryStore } from '../store/useLibraryStore';
import { useUIStore } from '../store/useUIStore';
import { recommendationEngine } from '../services/recommendationEngine';
import { getOpenOverlayCount } from './useDismissable';
import { isMobileShellNow } from './useMobileShell';
import { isSlashKey, shortcutLetter } from '../utils/physicalKey';

const SEEK_STEP_SECONDS = 5;

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
 * Единственный слушатель сочетаний на всё окно.
 *
 * Буквы сверяются по клавише, а не по тому, что она печатает (`shortcutLetter`):
 * на русской раскладке `event.key` у `M` — «ь», у `K` — «л», и сравнение с
 * латиницей молчало. Клавиши без модификатора срабатывают только без
 * модификаторов, так что `Ctrl+F`, `Alt+Q` и прочие по-прежнему доходят до
 * браузера и системы.
 */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Открыты «Итоги»: клавиши листают истории, а не управляют плеером.
      if (useUIStore.getState().recapPeriod) return;

      const player = usePlayerStore.getState();
      const ui = useUIStore.getState();
      const isMod = event.ctrlKey || event.metaKey;
      const letter = shortcutLetter(event);

      /*
       * Палитра команд — единственное сочетание с Ctrl/Cmd, и оно стоит ДО
       * проверки «человек печатает». Раньше стояло после, а курсор в этом
       * приложении почти всегда в поиске шапки: Ctrl+K оттуда не открывал
       * ничего, а из строки самой палитры — не закрывал её. Буквы Ctrl+K не
       * печатает, так что отнимать у поля тут нечего.
       *
       * В телефонной оболочке палитры нет вовсе — там сочетание не трогаем,
       * иначе флаг «открыта» взводился бы впустую и съедал следующий Esc.
       */
      if (isMod && !event.altKey && letter === 'k') {
        if (isMobileShellNow()) return;
        event.preventDefault();
        // Зажатая клавиша шлёт повторы — без этого палитра мигала бы.
        if (!event.repeat) ui.toggleCommandPalette();
        return;
      }

      if (isFromTextEntry(event.target)) return;
      // Уступаем только те клавиши, которыми элемент под фокусом реально
      // управляется. Раньше уступали все подряд, и после щелчка по кнопке или
      // ползунку переставало работать вообще всё, включая `M`.
      if (CONTROL_KEYS.has(event.key) && isFromInteractiveControl(event.target)) return;

      // Сочетания с Alt: Alt+W, Alt+R, Alt+M.
      if (event.altKey && !isMod && !event.shiftKey) {
        switch (letter) {
          // Alt+W: вкладка «Поток», а на ней — пуск и пауза волны.
          case 'w': {
            event.preventDefault();
            if (ui.activeView !== 'wave') {
              ui.setActiveView('wave');
              if (player.queueMode !== 'my_wave') {
                void player.startMyWave(ui.activeWaveMood, ui.activeWaveGenre);
              }
            } else if (player.queueMode === 'my_wave' && player.currentTrack) {
              void player.togglePlayPause();
            } else {
              void player.startMyWave(ui.activeWaveMood, ui.activeWaveGenre);
            }
            return;
          }

          // Alt+R: радио по играющему треку.
          case 'r': {
            event.preventDefault();
            if (player.currentTrack) {
              void player.startTrackRadio(player.currentTrack);
              ui.showToast(`Запущено радио по треку "${player.currentTrack.title}"`, 'success');
            }
            return;
          }

          // Alt+M: мини-плеер.
          case 'm': {
            event.preventDefault();
            void ui.toggleMiniPlayer();
            return;
          }

          default:
            break;
        }
      }

      if (isMod || event.altKey) return;

      // Одиночные буквы: M, F, Q, L, D — по клавише, в любой раскладке.
      if (letter && !event.shiftKey) {
        switch (letter) {
          case 'm': {
            event.preventDefault();
            player.toggleMute();
            return;
          }

          case 'f': {
            event.preventDefault();
            ui.toggleFullscreenPlayer();
            return;
          }

          case 'q': {
            event.preventDefault();
            ui.toggleQueue();
            return;
          }

          case 'l': {
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

          case 'd': {
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

          default:
            break;
        }
      }

      // Поиск: клавиша `/`. На русской раскладке она печатает точку, поэтому
      // сверяется по месту, а не по знаку.
      if (isSlashKey(event)) {
        event.preventDefault();
        if (ui.activeView !== 'search') ui.setActiveView('search');
        // Поле появляется вместе с экраном поиска, поэтому фокус — на следующем кадре.
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLInputElement>('[data-testid="search-input"]');
          input?.focus();
          input?.select();
        });
        return;
      }

      // Остальное — именованные клавиши, от раскладки они не зависят.
      switch (event.key) {
        case ' ':
        case 'Spacebar': {
          if (event.shiftKey) return;
          // Иначе пробел прокрутил бы экран за плеером.
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
