import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../setup';
import { SleepTimerPanel } from '../../src/components/player/SleepTimerPanel';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { resetPlayerStore } from '../helpers/testUtils';

describe('3.0: таймер сна на телефоне', () => {
  beforeEach(() => resetPlayerStore());
  afterEach(() => usePlayerStore.getState().setSleepTimer(null));

  it('ставит минуты и закрывает лист', () => {
    let picked = 0;
    render(<SleepTimerPanel onPicked={() => (picked += 1)} />);
    fireEvent.click(screen.getByTestId('sleep-panel-30'));
    expect(usePlayerStore.getState().sleepTimerEndsAt).not.toBeNull();
    expect(picked).toBe(1);
    expect(screen.getByTestId('sleep-timer-status').textContent).toMatch(/Остановится через/);
  });

  it('«Конец трека» и отключение', () => {
    render(<SleepTimerPanel />);
    expect(screen.queryByTestId('sleep-panel-off')).toBeNull();
    fireEvent.click(screen.getByTestId('sleep-panel-track-end'));
    expect(usePlayerStore.getState().sleepAtTrackEnd).toBe(true);
    expect(screen.getByTestId('sleep-timer-status').textContent).toMatch(/доиграет/);
    act(() => {
      fireEvent.click(screen.getByTestId('sleep-panel-off'));
    });
    expect(usePlayerStore.getState().sleepAtTrackEnd).toBe(false);
    expect(usePlayerStore.getState().sleepTimerEndsAt).toBeNull();
  });
});
