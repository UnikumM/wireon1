/**
 * Обновление на телефоне (`src/services/androidUpdater.ts`).
 *
 * Проверяется то, из-за чего обновления встают намертво: сравнение версий
 * строкой (тогда «1.0.9» больше «1.0.37») и выбор чужого файла из релиза, где
 * рядом с APK лежат установщики для Windows и Linux.
 */

import { describe, it, expect } from 'vitest';
import { isNewerVersion, pickApkAsset } from '../../src/services/androidUpdater';

describe('isNewerVersion', () => {
  it('сравнивает числами, а не буквами', () => {
    // Строкой «1.0.9» больше «1.0.37» — на этом обновления и застревают.
    expect(isNewerVersion('1.0.37', '1.0.9')).toBe(true);
    expect(isNewerVersion('1.0.9', '1.0.37')).toBe(false);
  });

  it('видит разницу в старших числах', () => {
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('1.1.0', '1.0.99')).toBe(true);
  });

  it('та же версия обновлением не считается', () => {
    expect(isNewerVersion('1.0.37', '1.0.37')).toBe(false);
  });

  it('не спотыкается о мусор вместо номера', () => {
    expect(isNewerVersion('', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.1', '')).toBe(true);
  });
});

describe('pickApkAsset', () => {
  const assets = [
    { name: 'latest.yml', browser_download_url: 'https://x/latest.yml', size: 300 },
    { name: 'Wireon-Setup-1.0.28.exe', browser_download_url: 'https://x/setup.exe', size: 155_000_000 },
    { name: 'Wireon-1.0.28.AppImage', browser_download_url: 'https://x/app.AppImage', size: 219_000_000 },
    { name: 'Wireon-1.0.37.apk', browser_download_url: 'https://x/Wireon-1.0.37.apk', size: 40_500_000 }
  ];

  it('берёт из релиза именно APK, а не настольные файлы', () => {
    const update = pickApkAsset(assets, '1.0.36');

    expect(update).toEqual({
      version: '1.0.37',
      url: 'https://x/Wireon-1.0.37.apk',
      size: 40_500_000,
      name: 'Wireon-1.0.37.apk'
    });
  });

  it('молчит, когда установлена та же версия или новее', () => {
    expect(pickApkAsset(assets, '1.0.37')).toBeNull();
    expect(pickApkAsset(assets, '1.0.40')).toBeNull();
  });

  it('молчит, когда APK в релизе нет', () => {
    expect(pickApkAsset(assets.slice(0, 3), '1.0.1')).toBeNull();
  });

  it('пропускает файл без ссылки на скачивание', () => {
    expect(pickApkAsset([{ name: 'Wireon-1.0.99.apk', size: 1 }], '1.0.1')).toBeNull();
  });
});
