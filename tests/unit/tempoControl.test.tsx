import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '../setup';

import { TempoControl, TEMPO_PRESETS, formatRate } from '../../src/components/player/TempoControl';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { dbService } from '../../src/services/db';
import { MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE, audioEngine } from '../../src/services/audioEngine';

/** Opens the popover and returns it, so no test repeats the two-step dance. */
function openPanel(): HTMLElement {
  fireEvent.click(screen.getByTestId('tempo-button'));
  return screen.getByTestId('tempo-panel');
}

describe('TempoControl — компактная кнопка «настроить песню»', () => {
  beforeEach(() => {
    usePlayerStore.setState({ playbackRate: 1, preservePitch: false });
    audioEngine.setPlaybackRate(1, false);
  });

  describe('formatRate', () => {
    it('пишет обычную скорость без дробной части', () => {
      expect(formatRate(1)).toBe('1×');
      expect(formatRate(2)).toBe('2×');
    });

    it('оставляет два знака, когда они значимы', () => {
      expect(formatRate(0.65)).toBe('0.65×');
      expect(formatRate(1.25)).toBe('1.25×');
    });

    it('срезает висящий ноль', () => {
      expect(formatRate(0.8)).toBe('0.8×');
      expect(formatRate(1.4)).toBe('1.4×');
      expect(formatRate(MIN_PLAYBACK_RATE)).toBe('0.5×');
    });

    it('округляет то, что приходит со слайдера', () => {
      // 0.05 шаг слайдера иногда даёт 0.7000000000000001 — на кнопке это недопустимо.
      expect(formatRate(0.7000000000000001)).toBe('0.7×');
      expect(formatRate(1.1499999)).toBe('1.15×');
    });
  });

  describe('Кнопка', () => {
    it('на обычной скорости показывает только иконку, без бейджа', () => {
      render(<TempoControl />);

      expect(screen.getByTestId('tempo-button')).toHaveAttribute('aria-label', 'Настроить песню');
      expect(screen.getByTestId('tempo-button')).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByTestId('tempo-button')).toHaveAttribute('aria-haspopup', 'dialog');
      expect(screen.queryByTestId('tempo-badge')).toBeNull();
      expect(screen.getByTestId('tempo-button').getAttribute('title')).toBe(
        'Настроить песню: скорость и тональность'
      );
    });

    it('на изменённой скорости выносит её на лицо кнопки вместе с названием пресета', () => {
      usePlayerStore.setState({ playbackRate: 0.8 });
      render(<TempoControl />);

      expect(screen.getByTestId('tempo-badge')).toHaveTextContent('0.8×');
      expect(screen.getByTestId('tempo-button').getAttribute('title')).toBe(
        'Скорость 0.8× — Super slowed'
      );
    });

    it('для скорости вне пресетов показывает бейдж без названия', () => {
      usePlayerStore.setState({ playbackRate: 0.75 });
      render(<TempoControl />);

      expect(screen.getByTestId('tempo-badge')).toHaveTextContent('0.75×');
      expect(screen.getByTestId('tempo-button').getAttribute('title')).toBe('Скорость 0.75×');
    });

    it('подстраивает размер под окружение', () => {
      // Размер идёт токенами --control-*, парными к шкале ICON, поэтому здесь
      // проверяется имя ступени, а не пиксели: jsdom var() не раскрывает.
      const { unmount } = render(<TempoControl />);
      expect(screen.getByTestId('tempo-button').style.height).toBe('var(--control-md)');
      unmount();

      render(<TempoControl size="lg" />);
      expect(screen.getByTestId('tempo-button').style.height).toBe('var(--control-lg)');
    });

    it('прижимает панель к той стороне, где стоит сама кнопка', () => {
      const { unmount } = render(<TempoControl />);
      fireEvent.click(screen.getByTestId('tempo-button'));
      expect(screen.getByTestId('tempo-panel').style.right).toBe('0px');
      expect(screen.getByTestId('tempo-panel').style.left).toBe('');
      unmount();

      // У левого края экрана панель, прижатая справа, уехала бы за пределы окна.
      render(<TempoControl align="left" />);
      fireEvent.click(screen.getByTestId('tempo-button'));
      expect(screen.getByTestId('tempo-panel').style.left).toBe('0px');
      expect(screen.getByTestId('tempo-panel').style.right).toBe('');
    });
  });

  describe('Панель', () => {
    it('открывается и закрывается по той же кнопке', () => {
      render(<TempoControl />);

      openPanel();
      expect(screen.getByTestId('tempo-panel')).toHaveAttribute('role', 'dialog');
      expect(screen.getByTestId('tempo-panel')).toHaveAttribute('aria-label', 'Настройка звучания');
      expect(screen.getByTestId('tempo-button')).toHaveAttribute('aria-expanded', 'true');

      fireEvent.click(screen.getByTestId('tempo-button'));
      expect(screen.queryByTestId('tempo-panel')).toBeNull();
      expect(screen.getByTestId('tempo-button')).toHaveAttribute('aria-expanded', 'false');
    });

    it('закрывается по Escape', () => {
      render(<TempoControl />);
      openPanel();

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(screen.queryByTestId('tempo-panel')).toBeNull();
    });

    it('содержит все три способа настройки сразу', () => {
      render(<TempoControl />);
      openPanel();

      expect(screen.getByRole('group', { name: 'Пресеты скорости' })).toBeInTheDocument();
      expect(screen.getByTestId('tempo-manual')).toBeInTheDocument();
      expect(screen.getByTestId('tempo-preserve-pitch')).toBeInTheDocument();
    });
  });

  describe('Пресеты', () => {
    it('показывает все шесть пресетов с подписью скорости', () => {
      render(<TempoControl />);
      openPanel();

      expect(TEMPO_PRESETS).toHaveLength(6);
      for (const preset of TEMPO_PRESETS) {
        const chip = screen.getByTestId(`tempo-preset-${preset.rate}`);
        expect(chip).toHaveTextContent(preset.label);
        expect(chip).toHaveTextContent(formatRate(preset.rate));
        expect(chip.getAttribute('title')).toBe(preset.hint);
      }
    });

    /*
     * Сетка обязана уметь сжимать колонку.
     *
     * Было `1fr 1fr`: такая колонка уже своего содержимого не становится, а
     * шесть чипов просят 322 px при панели в 268 — правый столбец вылезал за
     * край панели и висел в воздухе рядом с ней. `minmax(0, 1fr)` разрешает
     * колонке сжаться, и в крайнем случае подпись обрежется многоточием внутри
     * панели. Ширина панели с запасом на самую длинную подпись — вторая
     * половина той же починки, но одной ширины мало: подписи могут вырасти.
     */
    it('колонки пресетов умеют сжиматься, а панель шире самой длинной подписи', () => {
      render(<TempoControl />);
      openPanel();

      const group = screen.getByRole('group', { name: 'Пресеты скорости' });
      expect(group.style.gridTemplateColumns).toBe('minmax(0, 1fr) minmax(0, 1fr)');

      const panel = screen.getByTestId('tempo-panel');
      expect(panel.style.width).toContain('344px');
      expect(panel.style.maxWidth).toContain('100vw');
    });

    it.each(TEMPO_PRESETS.map((preset) => [preset.label, preset.rate] as const))(
      'по нажатию «%s» ставит скорость %s',
      (_label, rate) => {
        usePlayerStore.setState({ playbackRate: 0.5 });
        render(<TempoControl />);
        openPanel();

        fireEvent.click(screen.getByTestId(`tempo-preset-${rate}`));

        expect(usePlayerStore.getState().playbackRate).toBe(rate);
        expect(audioEngine.getPlaybackRate()).toBe(rate);
        cleanup();
      }
    );

    it('отмечает активный пресет и только его', () => {
      usePlayerStore.setState({ playbackRate: 1.4 });
      render(<TempoControl />);
      openPanel();

      const active = screen.getByTestId('tempo-preset-1.4');
      expect(active).toHaveAttribute('aria-checked', 'true');
      expect(active).toHaveAttribute('data-active', 'true');

      for (const preset of TEMPO_PRESETS.filter((p) => p.rate !== 1.4)) {
        expect(screen.getByTestId(`tempo-preset-${preset.rate}`)).toHaveAttribute('aria-checked', 'false');
      }
    });

    it('на скорости вне пресетов не отмечает ни один', () => {
      usePlayerStore.setState({ playbackRate: 1.15 });
      render(<TempoControl />);
      openPanel();

      for (const preset of TEMPO_PRESETS) {
        expect(screen.getByTestId(`tempo-preset-${preset.rate}`)).toHaveAttribute('aria-checked', 'false');
      }
    });

    it('«Обычная» убирает бейдж и кнопку сброса', () => {
      usePlayerStore.setState({ playbackRate: 0.65 });
      render(<TempoControl />);
      openPanel();

      fireEvent.click(screen.getByTestId('tempo-preset-1'));

      expect(usePlayerStore.getState().playbackRate).toBe(1);
      expect(screen.queryByTestId('tempo-badge')).toBeNull();
      expect(screen.queryByTestId('tempo-reset')).toBeNull();
    });

    it('переживает перезапуск: выбранная скорость уходит в настройки', async () => {
      render(<TempoControl />);
      openPanel();

      fireEvent.click(screen.getByTestId('tempo-preset-0.8'));
      await Promise.resolve();

      expect(await dbService.getSetting<number>('playbackRate', -1)).toBe(0.8);
    });
  });

  describe('Ручная настройка', () => {
    it('слайдер ограничен диапазоном движка', () => {
      render(<TempoControl />);
      openPanel();

      const slider = screen.getByTestId('tempo-slider');
      expect(slider).toHaveAttribute('min', String(MIN_PLAYBACK_RATE));
      expect(slider).toHaveAttribute('max', String(MAX_PLAYBACK_RATE));
      expect(slider).toHaveAttribute('step', '0.05');
      expect(slider).toHaveAttribute('aria-label', 'Скорость воспроизведения');
    });

    it('слайдер отражает текущую скорость и меняет её', () => {
      usePlayerStore.setState({ playbackRate: 1.25 });
      render(<TempoControl />);
      openPanel();

      expect(screen.getByTestId('tempo-slider')).toHaveValue('1.25');

      fireEvent.change(screen.getByTestId('tempo-slider'), { target: { value: '1.75' } });

      expect(usePlayerStore.getState().playbackRate).toBe(1.75);
      expect(screen.getByTestId('tempo-slider')).toHaveValue('1.75');
    });

    it('показывает скорость числом рядом со словом «Вручную»', () => {
      usePlayerStore.setState({ playbackRate: 0.9 });
      render(<TempoControl />);
      openPanel();

      expect(screen.getByTestId('tempo-manual')).toHaveTextContent('Вручную');
      expect(screen.getByTestId('tempo-manual')).toHaveTextContent('0.9×');
    });

    it('значение за пределами диапазона не доходит до движка', () => {
      render(<TempoControl />);
      openPanel();

      // Слайдер сам не даст выйти за max, но обработчик всё равно обязан клампить:
      // тот же путь используют горячие клавиши и восстановление настроек.
      fireEvent.change(screen.getByTestId('tempo-slider'), { target: { value: '9' } });

      expect(usePlayerStore.getState().playbackRate).toBeLessThanOrEqual(MAX_PLAYBACK_RATE);
      expect(audioEngine.getPlaybackRate()).toBeLessThanOrEqual(MAX_PLAYBACK_RATE);
    });
  });

  describe('Сброс', () => {
    it('появляется только когда скорость изменена', () => {
      const { unmount } = render(<TempoControl />);
      openPanel();
      expect(screen.queryByTestId('tempo-reset')).toBeNull();
      unmount();

      usePlayerStore.setState({ playbackRate: 1.4 });
      render(<TempoControl />);
      openPanel();
      expect(screen.getByTestId('tempo-reset')).toHaveTextContent('Сбросить');
    });

    it('возвращает обычную скорость, не трогая тональность', () => {
      usePlayerStore.setState({ playbackRate: 0.65, preservePitch: true });
      render(<TempoControl />);
      openPanel();

      fireEvent.click(screen.getByTestId('tempo-reset'));

      expect(usePlayerStore.getState().playbackRate).toBe(1);
      expect(usePlayerStore.getState().preservePitch).toBe(true);
      expect(audioEngine.getPreservesPitch()).toBe(true);
      expect(screen.queryByTestId('tempo-badge')).toBeNull();
    });
  });

  describe('Тональность', () => {
    it('по умолчанию выключена — так звучат slowed и nightcore', () => {
      render(<TempoControl />);
      openPanel();

      const toggle = screen.getByTestId('tempo-preserve-pitch');
      expect(toggle).toHaveAttribute('role', 'switch');
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      // Пояснение живёт в `title`, а не строкой под названием: положение
      // переключателя уже сообщает состояние, и пересказывать его словами в
      // панели на 268 px значит добавить третий уровень текста.
      expect(toggle).toHaveAttribute('title', expect.stringContaining('Голос меняется вместе с темпом'));
    });

    it('включается по нажатию и объясняет, что изменилось', () => {
      render(<TempoControl />);
      openPanel();

      fireEvent.click(screen.getByTestId('tempo-preserve-pitch'));

      expect(usePlayerStore.getState().preservePitch).toBe(true);
      expect(screen.getByTestId('tempo-preserve-pitch')).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByTestId('tempo-preserve-pitch')).toHaveAttribute(
        'title',
        'Меняется только темп, голос остаётся прежним'
      );
    });

    it('переключение сохраняет уже выбранную скорость', () => {
      usePlayerStore.setState({ playbackRate: 0.8 });
      render(<TempoControl />);
      openPanel();

      fireEvent.click(screen.getByTestId('tempo-preserve-pitch'));

      expect(usePlayerStore.getState().playbackRate).toBe(0.8);
      expect(audioEngine.getPlaybackRate()).toBe(0.8);
      expect(screen.getByTestId('tempo-badge')).toHaveTextContent('0.8×');
    });
  });
});
