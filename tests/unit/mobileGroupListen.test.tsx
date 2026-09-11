/**
 * Совместное прослушивание на телефоне.
 *
 * Окно комнаты монтировала шапка, а своей шапки у телефона нет: позвать в
 * комнату можно было только с компьютера — при том что зовут в неё как раз с
 * телефона, из дороги.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '../setup';
import { MobileSettingsView } from '../../src/components/mobile/MobileSettingsView';
import { useGroupListenStore } from '../../src/store/useGroupListenStore';

describe('вход в комнату с телефона', () => {
  beforeEach(() => {
    useGroupListenStore.setState({ isModalOpen: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('строка настроек открывает окно комнаты', async () => {
    render(<MobileSettingsView />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-settings-row-together'));
    });

    expect(useGroupListenStore.getState().isModalOpen).toBe(true);
  });

  it('комната не разворачивается списком настроек внутри страницы', async () => {
    render(<MobileSettingsView />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('mobile-settings-row-together'));
    });

    // Раздел не «раскрылся»: список остался списком, а комната ушла в своё окно.
    expect(screen.queryByTestId('mobile-settings-section')).toBeNull();
    expect(screen.getByTestId('mobile-settings-row-account')).toBeTruthy();
  });
});
