import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../setup';
import { AudioEngine } from '../../src/services/audioEngine';
import { usePlayerStore } from '../../src/store/usePlayerStore';
import { PlaybackSettings } from '../../src/components/settings/PlaybackSettings';
import * as dbService from '../../src/services/db';
import { resetPlayerStore } from '../helpers/testUtils';

describe('3.0: баланс и моно', () => {
  beforeEach(async () => {
    await dbService.clearAllData();
    resetPlayerStore();
  });

  it('движок ограничивает баланс и ставит его на узел', async () => {
    const engine = new AudioEngine();
    engine.setBalance(5);
    expect(engine.getBalance()).toBe(1);
    engine.setBalance(-0.333);
    expect(engine.getBalance()).toBe(-0.33);
    engine.setBalance(Number.NaN);
    expect(engine.getBalance()).toBe(0);
    engine.setMono(true);
    expect(engine.isMono()).toBe(true);
    // Граф строится на первой загрузке; узлы получают уже выбранные значения.
    engine.setBalance(0.5);
    (engine as any).initAudioGraph();
    expect((engine as any).pannerNode.pan.value).toBe(0.5);
    const master = engine.getMasterGainNode() as any;
    // Моно включено — мастер идёт в узел сведения, а не сразу в баланс.
    expect(master.connectedTo).toContain((engine as any).monoNode);
    engine.setMono(false);
    expect(master.connectedTo).toContain((engine as any).pannerNode);
    engine.destroy();
  });

  it('стор прилипает к центру и запоминает выбор', async () => {
    usePlayerStore.getState().setAudioBalance(0.02);
    expect(usePlayerStore.getState().audioBalance).toBe(0);
    usePlayerStore.getState().setAudioBalance(-0.6);
    usePlayerStore.getState().setAudioMono(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(await dbService.getSetting('audioBalance', 0)).toBe(-0.6);
    expect(await dbService.getSetting('audioMono', false)).toBe(true);

    usePlayerStore.setState({ audioBalance: 0, audioMono: false, settingsHydrated: false });
    await usePlayerStore.getState().hydrateSettings();
    expect(usePlayerStore.getState().audioBalance).toBe(-0.6);
    expect(usePlayerStore.getState().audioMono).toBe(true);
  });

  it('настройки показывают баланс словами', () => {
    render(<PlaybackSettings />);
    expect(screen.getByTestId('setting-audio-balance-value')).toHaveTextContent('центр');
    fireEvent.change(screen.getByTestId('setting-audio-balance'), { target: { value: '-40' } });
    expect(usePlayerStore.getState().audioBalance).toBe(-0.4);
    expect(screen.getByTestId('setting-audio-balance-value')).toHaveTextContent('Л 40');
    fireEvent.click(screen.getByTestId('setting-audio-mono'));
    expect(usePlayerStore.getState().audioMono).toBe(true);
  });
});
