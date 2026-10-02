/**
 * Публикация релиза (`scripts/publish-release.mjs`).
 *
 * На 2.2.6 electron-builder опять создал релиз двумя параллельными запросами,
 * второй GitHub отбил, и latest.yml не загрузился: установщик на странице был,
 * а обновление не пришло бы никому. Теперь релиз заранее создаётся черновиком
 * и публикуется, только когда в нём есть всё, что читает автообновление.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

import {
  prepare,
  publish,
  releaseNotes,
  missingAssets,
  requiredWindowsAssets,
  createGitHub
} from '../../scripts/publish-release.mjs';

type Release = { id: number; tag_name: string; draft: boolean; assets: Array<{ name: string }>; html_url?: string };

function fakeGitHub(initial: Release | null) {
  let release = initial;
  return {
    findRelease: vi.fn(async (tag: string) => (release && release.tag_name === tag ? release : null)),
    createDraft: vi.fn(async ({ tag }: { tag: string }) => {
      release = { id: 1, tag_name: tag, draft: true, assets: [] };
      return release;
    }),
    publish: vi.fn(async (r: Release) => ({ ...r, draft: false, html_url: 'https://github.com/x/y/releases/tag/v1' })),
    upload(name: string) {
      release?.assets.push({ name });
    }
  };
}

const quiet = () => {};

describe('publish-release', () => {
  it('создаёт черновик, а не публичный релиз — его не видят ни компьютеры, ни телефоны', async () => {
    const github = fakeGitHub(null);
    const release = await prepare({ github, version: '2.2.7', notes: 'n', target: 'abc', log: quiet });
    expect(github.createDraft).toHaveBeenCalledWith({ tag: 'v2.2.7', name: '2.2.7', body: 'n', target: 'abc' });
    expect(release.draft).toBe(true);
  });

  it('повторный запуск грузит в тот же черновик, а не создаёт второй', async () => {
    const github = fakeGitHub({ id: 5, tag_name: 'v2.2.7', draft: true, assets: [] });
    await prepare({ github, version: '2.2.7', notes: '', log: quiet });
    expect(github.createDraft).not.toHaveBeenCalled();
  });

  it('не публикует релиз без latest.yml — ровно то, что случилось с 2.2.6', async () => {
    const github = fakeGitHub({ id: 5, tag_name: 'v2.2.7', draft: true, assets: [{ name: 'Wireon-Setup-2.2.7.exe' }] });
    await expect(publish({ github, version: '2.2.7', log: quiet })).rejects.toThrow(/latest\.yml/);
    expect(github.publish).not.toHaveBeenCalled();
  });

  it('публикует, когда установщик, blockmap и latest.yml на месте', async () => {
    const github = fakeGitHub(null);
    await prepare({ github, version: '2.2.7', notes: '', log: quiet });
    requiredWindowsAssets('2.2.7').forEach((name) => github.upload(name));
    const published = await publish({ github, version: '2.2.7', log: quiet });
    expect(github.publish).toHaveBeenCalledTimes(1);
    expect(published.draft).toBe(false);
  });

  it('уже опубликованный и полный релиз не трогает', async () => {
    const github = fakeGitHub({
      id: 5,
      tag_name: 'v2.2.7',
      draft: false,
      assets: requiredWindowsAssets('2.2.7').map((name) => ({ name }))
    });
    await publish({ github, version: '2.2.7', log: quiet });
    expect(github.publish).not.toHaveBeenCalled();
  });

  it('список недостающих — по именам, которые ждёт автообновление', () => {
    expect(requiredWindowsAssets('2.2.6')).toEqual(['Wireon-Setup-2.2.6.exe', 'Wireon-Setup-2.2.6.exe.blockmap', 'latest.yml']);
    expect(missingAssets({ assets: [{ name: 'latest.yml' }] }, ['a.exe', 'latest.yml'])).toEqual(['a.exe']);
    expect(missingAssets(null, ['latest.yml'])).toEqual(['latest.yml']);
  });

  it('текст релиза — тот же «Что нового», что в приложении', () => {
    const source = readFileSync(path.join(__dirname, '../../src/data/changelog.ts'), 'utf8');
    const notes = releaseNotes(source, '2.2.6');
    expect(notes.split('\n')[0]).toBe('Поток от вашей библиотеки, быстрый YouTube, SoundCloud на телефоне и новый вид');
    expect(notes).toContain('- **Фон в цвет акцента** — ');
    // Записи соседних версий не подмешиваются.
    expect(notes).not.toContain('Меню плеера снова нажимается мышью');
    expect(releaseNotes(source, '9.9.9')).toBe('');
  });

  it('ходит в API своего репозитория с токеном и отдаёт понятную ошибку', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'Bad credentials' }));
    const github = createGitHub({ token: 't', owner: 'UnikumM', repo: 'wireon1', fetchImpl: fetchImpl as never });
    await expect(github.findRelease('v1')).rejects.toThrow(/HTTP 401 Bad credentials/);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://api.github.com/repos/UnikumM/wireon1/releases?per_page=50');
    expect(init.headers.Authorization).toBe('Bearer t');
  });
});
