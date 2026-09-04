import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import '../setup';
import { APP_VERSION, buildErrorReport, runtimeLabel } from '../../src/utils/appInfo';

/**
 * `appInfo.ts` знает три вещи: версию, среду и как из падения сделать текст,
 * который человек просто вставит в сообщение. Версия дублирует манифест руками,
 * поэтому расхождение ловится здесь — иначе в отчётах поддержки будет числиться
 * не та сборка, что у пользователя.
 */

const ROOT = process.cwd();

describe('appInfo: версия и среда', () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('версия совпадает с package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('в браузере так и написано «Браузер»', () => {
    expect(runtimeLabel()).toBe('Браузер');
  });

  it('в настольной сборке платформа переведена на русский', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { getPlatform: () => 'win32' };
    expect(runtimeLabel()).toBe('Приложение · Windows');

    (window as unknown as { electronAPI: unknown }).electronAPI = { getPlatform: () => 'darwin' };
    expect(runtimeLabel()).toBe('Приложение · macOS');

    (window as unknown as { electronAPI: unknown }).electronAPI = { getPlatform: () => 'linux' };
    expect(runtimeLabel()).toBe('Приложение · Linux');
  });

  it('незнакомую платформу показывает как есть, а не «undefined»', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = { getPlatform: () => 'freebsd' };
    expect(runtimeLabel()).toBe('Приложение · freebsd');
  });

  it('не падает, когда мост есть, а метода в нём нет', () => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    expect(runtimeLabel()).toBe('Браузер');
  });
});

describe('appInfo: отчёт об ошибке', () => {
  it('начинается с того, что нужно поддержке в первую очередь', () => {
    const report = buildErrorReport({ message: 'не открылся плеер' });
    const lines = report.split('\n');

    expect(lines[0]).toBe(`Wireon Sounds ${APP_VERSION}`);
    expect(lines[1]).toBe('Среда: Браузер');
    expect(lines[2]).toContain('User agent:');
    expect(report).toContain('Ошибка: не открылся плеер');
  });

  it('добавляет оба стека отдельными разделами', () => {
    const report = buildErrorReport({
      message: 'упало',
      stack: '  Error: упало\n    at Visualizer  ',
      componentStack: '\n    in Visualizer\n    in PlayerBar\n'
    });

    expect(report).toContain('\nСтек:\nError: упало');
    expect(report).toContain('\nКомпоненты:\nin Visualizer');
    // Отбивка пустой строкой — иначе в мессенджере это слипнется в кашу.
    expect(report).toMatch(/\n\nСтек:/);
    expect(report).toMatch(/\n\nКомпоненты:/);
  });

  it('без стеков не оставляет пустых заголовков', () => {
    const report = buildErrorReport({ message: 'тихо', stack: null, componentStack: null });

    expect(report).not.toContain('Стек:');
    expect(report).not.toContain('Компоненты:');
    expect(report.endsWith('Ошибка: тихо')).toBe(true);
  });

  it('называет экран, если он известен', () => {
    expect(buildErrorReport({ message: 'x', view: 'Поток' })).toContain('Экран: Поток');
    expect(buildErrorReport({ message: 'x' })).not.toContain('Экран:');
  });

  it('ошибка без сообщения не превращается в пустую строку', () => {
    expect(buildErrorReport({ message: '' })).toContain('Ошибка: без сообщения');
  });

  it('не выносит наружу ни токена, ни того, что человек слушал', () => {
    localStorage.setItem('wireon_auth_token', 'секретный_токен_42');
    try {
      const report = buildErrorReport({
        message: 'сломалось',
        stack: 'at play (streamResolver.ts:1:1)',
        componentStack: 'in TrackRow'
      });

      expect(report).not.toContain('секретный_токен_42');
      expect(report).not.toMatch(/wireon_auth|access_token|Bearer/);
    } finally {
      localStorage.clear();
    }
  });

  it('переживает окружение без navigator', () => {
    const original = globalThis.navigator;
    // Типы такого не допускают, но в проде это бывает (worker, старый WebView).
    vi.stubGlobal('navigator', undefined);

    try {
      const report = buildErrorReport({ message: 'без браузера' });
      expect(report).not.toContain('User agent:');
      expect(report).toContain('Ошибка: без браузера');
    } finally {
      vi.stubGlobal('navigator', original);
    }
  });
});
