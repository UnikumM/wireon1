import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import '../setup';
import { defaultAppLayout, normalizeAppLayout, useAppLayoutStore, APP_LAYOUT_KEY } from '../../src/store/useAppLayoutStore';
import { HomeLayout } from '../../src/components/home/HomeLayout';
import { CustomAppFrame } from '../../src/components/layout/CustomAppFrame';
import * as db from '../../src/services/db';

beforeEach(() => {
  useAppLayoutStore.setState({ desktop: defaultAppLayout('desktop'), mobile: defaultAppLayout('mobile'), editHome: false, hydrated: false });
  vi.spyOn(db, 'setSetting').mockResolvedValue();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('App layout', () => {
  it('normalizes saved data without duplicates, invalid panels, or an inaccessible home', () => {
    const layout = normalizeAppLayout({ navigationPosition: 'unknown', playerWidth: Infinity,
      tabs: ['wave', 'wave', 'unknown'], hiddenTabs: ['home', 'search'], homeColumns: 8 }, 'mobile');
    expect(layout.navigationPosition).toBe('bottom');
    expect(layout.tabs).toEqual(['wave', 'home', 'search', 'foryou', 'library']);
    expect(layout.hiddenTabs).toEqual(['search']);
    expect(layout.playerWidth).toBe(240);
    expect(layout.homeColumns).toBe(1);
  });

  it('keeps separate device preferences and resets only the chosen device', () => {
    useAppLayoutStore.getState().update('mobile', { navigationPosition: 'left', playerPosition: 'top' });
    expect(useAppLayoutStore.getState().desktop.navigationPosition).toBe('top');
    useAppLayoutStore.getState().update('desktop', { navigationPosition: 'right' });
    useAppLayoutStore.getState().reset('desktop');
    expect(useAppLayoutStore.getState().mobile.playerPosition).toBe('top');
    expect(useAppLayoutStore.getState().desktop).toEqual(defaultAppLayout('desktop'));
  });

  it('saves the latest layout when tabs are moved and toggled quickly', async () => {
    useAppLayoutStore.getState().move('desktop', 'tabs', 'wave', 0);
    useAppLayoutStore.getState().toggle('desktop', 'hiddenTabs', 'search');
    await vi.waitFor(() => expect(db.setSetting).toHaveBeenLastCalledWith(APP_LAYOUT_KEY,
      expect.objectContaining({ desktop: expect.objectContaining({ hiddenTabs: ['search'], tabs: ['wave', 'home', 'search', 'foryou', 'library'] }) })));
  });

  it('restores both layouts after reopening', async () => {
    vi.spyOn(db, 'getSetting').mockResolvedValue({ desktop: { navigationPosition: 'right' }, mobile: { playerPosition: 'top' } });
    await useAppLayoutStore.getState().hydrate();
    expect(useAppLayoutStore.getState().desktop.navigationPosition).toBe('right');
    expect(useAppLayoutStore.getState().mobile.playerPosition).toBe('top');
  });

  it('does not overwrite a user change made while saved layout is loading', async () => {
    let resolve!: (value: unknown) => void;
    vi.spyOn(db, 'getSetting').mockImplementation(() => new Promise((r) => { resolve = r; }) as never);
    const reading = useAppLayoutStore.getState().hydrate();
    useAppLayoutStore.getState().update('desktop', { playerPosition: 'left' });
    resolve({ desktop: { playerPosition: 'right' } });
    await reading;
    expect(useAppLayoutStore.getState().desktop.playerPosition).toBe('left');
  });

  it('provides touch and keyboard controls for reordering and hiding home blocks', () => {
    render(<HomeLayout platform="mobile" testId="test-home"><section data-home-block="hero">Hero</section><section data-home-block="wave">Wave</section></HomeLayout>);
    fireEvent.click(screen.getByRole('button', { name: 'Настроить главную' }));
    fireEvent.click(screen.getByRole('button', { name: 'Поток: выше' }));
    expect(useAppLayoutStore.getState().mobile.homeBlocks.indexOf('wave')).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть: Поток' }));
    expect(screen.queryByText('Wave')).toBeNull();
    act(() => useAppLayoutStore.getState().reset('mobile'));
    expect(screen.getByText('Wave')).toBeInTheDocument();
  });

  it.each(['top', 'bottom', 'left', 'right'] as const)('places each panel at %s without covering content', (position) => {
    const { container } = render(<CustomAppFrame platform="desktop" layout={{ ...defaultAppLayout('desktop'), navigationPosition: position, playerPosition: position }}
      navigation={<nav>Navigation</nav>} player={<div>Player</div>}><main>Music</main></CustomAppFrame>);
    expect(container.querySelector(`.layout-${position} .layout-nav`)?.textContent).toBe('Navigation');
    expect(container.querySelector(`.layout-${position} .layout-player`)?.textContent).toBe('Player');
    expect(container.querySelector('.layout-content')?.textContent).toBe('Music');
  });
});
