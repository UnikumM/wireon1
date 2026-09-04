import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import '../setup';

import { UpdateBanner } from '../../src/components/common/UpdateBanner';
import { AboutSettings, describeUpdateState } from '../../src/components/settings/AboutSettings';
import { useUpdateStore } from '../../src/store/useUpdateStore';
import type { UpdateState } from '../../src/types/electron';

/**
 * Автообновление со стороны человека.
 *
 * Проверяется ровно то, что он видит: фоновая проверка молчит, загрузка идёт
 * тонкой строкой с процентом, а когда пакет скачан — та же строка просит
 * перезапустить. Подробности (ручная проверка, ошибки) живут в настройках, где
 * на них можно посмотреть по своей воле.
 */

/** Стоит вместо главного процесса: состояние можно толкать в окно, как он. */
function installUpdateBridge(initial: Partial<UpdateState> = {}) {
  const listeners = new Set<(state: UpdateState) => void>();
  const state: UpdateState = {
    status: 'idle',
    currentVersion: '1.0.0',
    newVersion: null,
    percent: 0,
    message: null,
    checkedAt: null,
    ...initial
  };

  const api = {
    getUpdateState: vi.fn(async () => ({ ...state })),
    checkForUpdates: vi.fn(async () => ({ ...state })),
    installUpdate: vi.fn(async () => true),
    onUpdateState: (callback: (next: UpdateState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };

  const previous = (window as unknown as { electronAPI?: unknown }).electronAPI;
  (window as unknown as { electronAPI?: unknown }).electronAPI = api;

  return {
    api,
    /** Меняет состояние и рассылает его, как это делает главный процесс. */
    push: (patch: Partial<UpdateState>) =>
      act(() => {
        Object.assign(state, patch);
        listeners.forEach((listener) => listener({ ...state }));
      }),
    restore: () => {
      (window as unknown as { electronAPI?: unknown }).electronAPI = previous;
    }
  };
}

/** Даёт осесть промису из init()/check(): состояние приходит через микротаск. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Плашка «обновление готово»', () => {
  let bridge: ReturnType<typeof installUpdateBridge> | null = null;

  beforeEach(() => {
    useUpdateStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    bridge?.restore();
    bridge = null;
  });

  it('фоновая проверка проходит молча', async () => {
    bridge = installUpdateBridge();
    render(<UpdateBanner />);
    await flush();

    expect(screen.queryByTestId('update-banner')).toBeNull();

    // Проверка раз в шесть часов — не новость, говорить не о чем.
    await bridge.push({ status: 'checking' });
    expect(screen.queryByTestId('update-banner')).toBeNull();

    await bridge.push({ status: 'up-to-date', checkedAt: 1 });
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('показывает загрузку с процентом и не предлагает перезапуск раньше времени', async () => {
    bridge = installUpdateBridge();
    render(<UpdateBanner />);
    await flush();

    await bridge.push({ status: 'available', newVersion: '1.2.0' });
    let banner = screen.getByTestId('update-banner');
    expect(banner).toHaveAttribute('data-phase', 'downloading');
    expect(banner).toHaveTextContent('Вышла версия 1.2.0');
    expect(banner).toHaveTextContent(/начинаем загрузку/i);
    // Перезапускать нечего: пакета на диске ещё нет.
    expect(screen.queryByTestId('update-restart')).toBeNull();

    await bridge.push({ status: 'downloading', percent: 64 });
    banner = screen.getByTestId('update-banner');
    expect(banner).toHaveTextContent(/качаем, 64%/);
    expect(screen.getByTestId('update-banner-progress')).toHaveAttribute('aria-valuenow', '64');
    expect(screen.queryByTestId('update-restart')).toBeNull();
  });

  it('когда пакет скачан, называет версию и просит перезапустить', async () => {
    bridge = installUpdateBridge();
    render(<UpdateBanner />);
    await flush();

    await bridge.push({ status: 'ready', newVersion: '1.2.0', percent: 100 });

    const banner = screen.getByTestId('update-banner');
    expect(banner).toHaveAttribute('data-phase', 'ready');
    expect(banner).toHaveTextContent('Wireon Sounds 1.2.0');
    expect(banner).toHaveTextContent(/перезапустите приложение/i);
    // Ни слова про «скачайте» — качать человеку нечего.
    expect(banner.textContent ?? '').not.toMatch(/скачайте|загрузите/i);
    // Полоса относится только к загрузке и на готовом пакете лишняя.
    expect(screen.queryByTestId('update-banner-progress')).toBeNull();
  });

  it('«Скрыть» на загрузке не глушит финальное «перезапустите»', async () => {
    bridge = installUpdateBridge();
    render(<UpdateBanner />);
    await flush();

    await bridge.push({ status: 'downloading', newVersion: '1.2.0', percent: 20 });
    fireEvent.click(screen.getByTestId('update-dismiss'));
    expect(screen.queryByTestId('update-banner')).toBeNull();

    // Проценты продолжают капать — плашка остаётся закрытой.
    await bridge.push({ status: 'downloading', newVersion: '1.2.0', percent: 80 });
    expect(screen.queryByTestId('update-banner')).toBeNull();

    // А вот готовый пакет требует действия, и об этом человек узнать обязан:
    // версия та же, поэтому по одной ей возврат плашки не отличить.
    await bridge.push({ status: 'ready', newVersion: '1.2.0', percent: 100 });
    expect(screen.getByTestId('update-banner')).toHaveTextContent(/перезапустите приложение/i);
  });

  it('окно, открытое уже после загрузки, всё равно узнаёт про обновление', async () => {
    // События не будет: оно случилось до того, как это окно появилось.
    bridge = installUpdateBridge({ status: 'ready', newVersion: '2.0.0', percent: 100 });
    render(<UpdateBanner />);
    await flush();

    expect(bridge.api.getUpdateState).toHaveBeenCalled();
    expect(screen.getByTestId('update-banner')).toHaveTextContent('Wireon Sounds 2.0.0');
  });

  it('«Перезапустить» запускает установку', async () => {
    bridge = installUpdateBridge();
    render(<UpdateBanner />);
    await flush();
    await bridge.push({ status: 'ready', newVersion: '1.2.0', percent: 100 });

    fireEvent.click(screen.getByTestId('update-restart'));
    await flush();

    expect(bridge.api.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('если установка не запустилась, человек узнаёт, что делать', async () => {
    bridge = installUpdateBridge();
    bridge.api.installUpdate.mockResolvedValue(false);
    render(<UpdateBanner />);
    await flush();
    await bridge.push({ status: 'ready', newVersion: '1.2.0', percent: 100 });

    fireEvent.click(screen.getByTestId('update-restart'));
    await flush();

    expect(useUpdateStore.getState().message).toMatch(/Закройте приложение и откройте снова/);
  });

  it('«Позже» убирает плашку, но новая версия возвращает её', async () => {
    bridge = installUpdateBridge();
    render(<UpdateBanner />);
    await flush();
    await bridge.push({ status: 'ready', newVersion: '1.2.0', percent: 100 });

    fireEvent.click(screen.getByTestId('update-dismiss'));
    expect(screen.queryByTestId('update-banner')).toBeNull();

    // Та же версия повторным событием больше не всплывает.
    await bridge.push({ status: 'ready', newVersion: '1.2.0', percent: 100 });
    expect(screen.queryByTestId('update-banner')).toBeNull();

    await bridge.push({ status: 'ready', newVersion: '1.3.0', percent: 100 });
    expect(screen.getByTestId('update-banner')).toHaveTextContent('Wireon Sounds 1.3.0');
  });

  it('в браузере не показывается и ничего не ждёт', async () => {
    const previous = (window as unknown as { electronAPI?: unknown }).electronAPI;
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;

    render(<UpdateBanner />);
    await flush();

    expect(screen.queryByTestId('update-banner')).toBeNull();
    expect(useUpdateStore.getState()).toMatchObject({ hasBridge: false, status: 'unsupported' });
    // Не ошибка, а просто «здесь нечего обновлять» — сообщения нет.
    expect(useUpdateStore.getState().message).toBeNull();

    (window as unknown as { electronAPI?: unknown }).electronAPI = previous;
  });
});

describe('Настройки: строка про обновления', () => {
  const base = {
    hasBridge: true,
    status: 'idle' as const,
    newVersion: null,
    percent: 0,
    message: null,
    checkedAt: null
  };

  it('в браузере честно говорит, где автообновление работает', () => {
    expect(describeUpdateState({ ...base, hasBridge: false })).toMatch(/только в приложении Wireon/);
  });

  it('в сборке без канала обновлений повторяет причину из главного процесса', () => {
    expect(
      describeUpdateState({
        ...base,
        status: 'unsupported',
        message: 'В этой сборке не указано, откуда брать обновления.'
      })
    ).toBe('В этой сборке не указано, откуда брать обновления.');
  });

  it('рассказывает, что происходит, на каждом шаге', () => {
    expect(describeUpdateState({ ...base, status: 'checking' })).toMatch(/Проверяем/);
    expect(describeUpdateState({ ...base, status: 'available', newVersion: '1.4.0' })).toMatch(
      /1\.4\.0.*качаем в фоне/i
    );
    expect(describeUpdateState({ ...base, status: 'downloading', percent: 41 })).toBe(
      'Качаем обновление: 41%. Можно продолжать слушать.'
    );
    expect(describeUpdateState({ ...base, status: 'ready', newVersion: '1.4.0' })).toMatch(
      /Версия 1\.4\.0 скачана/
    );
    expect(describeUpdateState({ ...base, status: 'idle' })).toMatch(/раз в несколько часов/);
  });

  it('«последняя версия» подкрепляется временем проверки', () => {
    const at = new Date(2026, 0, 5, 14, 32).getTime();
    expect(describeUpdateState({ ...base, status: 'up-to-date', checkedAt: at })).toBe(
      'Установлена последняя версия. Проверяли в 14:32.'
    );
    expect(describeUpdateState({ ...base, status: 'up-to-date' })).toBe('Установлена последняя версия.');
  });

  it('ошибку показывает словами главного процесса', () => {
    expect(
      describeUpdateState({
        ...base,
        status: 'error',
        message: 'Нет связи с сервером обновлений — попробуем позже.'
      })
    ).toBe('Нет связи с сервером обновлений — попробуем позже.');
  });
});

describe('Настройки: раздел «О программе»', () => {
  let bridge: ReturnType<typeof installUpdateBridge> | null = null;

  beforeEach(() => {
    useUpdateStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
    bridge?.restore();
    bridge = null;
  });

  it('без моста кнопка проверки не работает и это объяснено', () => {
    render(<AboutSettings />);

    expect(screen.getByText(/только в приложении Wireon/)).toBeInTheDocument();
    expect(screen.getByTestId('about-update-check')).toBeDisabled();
  });

  it('«Проверить» спрашивает главный процесс и показывает ответ', async () => {
    bridge = installUpdateBridge({ status: 'up-to-date', checkedAt: new Date(2026, 0, 5, 9, 5).getTime() });
    // Подписку держит плашка в оболочке приложения — здесь просто её результат.
    act(() => {
      useUpdateStore.setState({ hasBridge: true });
    });
    render(<AboutSettings />);

    fireEvent.click(screen.getByTestId('about-update-check'));
    await flush();

    expect(bridge.api.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Установлена последняя версия. Проверяли в 09:05.')).toBeInTheDocument();
  });

  it('во время загрузки показывает полосу с процентами', () => {
    act(() => {
      useUpdateStore.setState({ hasBridge: true, status: 'downloading', percent: 37 });
    });
    render(<AboutSettings />);

    const bar = screen.getByTestId('about-update-progress');
    expect(bar).toHaveAttribute('aria-valuenow', '37');
    expect(screen.getByTestId('about-update-check')).toBeDisabled();
    expect(screen.getByText(/Качаем обновление: 37%/)).toBeInTheDocument();
  });

  it('когда пакет скачан, вместо проверки предлагает перезапуск', async () => {
    bridge = installUpdateBridge({ status: 'ready', newVersion: '1.5.0' });
    act(() => {
      useUpdateStore.setState({ hasBridge: true, status: 'ready', newVersion: '1.5.0', percent: 100 });
    });
    render(<AboutSettings />);

    expect(screen.queryByTestId('about-update-check')).toBeNull();
    expect(screen.queryByTestId('about-update-progress')).toBeNull();

    fireEvent.click(screen.getByTestId('about-update-install'));
    await flush();

    expect(bridge.api.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('версию берёт из главного процесса — она про то, что реально запущено', () => {
    act(() => {
      useUpdateStore.setState({ hasBridge: true, currentVersion: '9.9.9' });
    });
    render(<AboutSettings />);

    expect(screen.getByText('9.9.9')).toBeInTheDocument();
  });
});
