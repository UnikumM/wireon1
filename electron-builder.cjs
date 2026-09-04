/**
 * Конфиг electron-builder с одним вычисляемым полем — каналом обновлений.
 *
 * Статика лежит в `electron-builder.json` (её удобно читать и валидировать по
 * схеме), а `publish` дописывается здесь, потому что владельца и имя репозитория
 * знает только тот, кто собирает: их берут из `WIREON_GH_OWNER`/`WIREON_GH_REPO`
 * или из git remote origin.
 *
 * Если ни того, ни другого нет — `publish` не добавляется вовсе. Такая сборка
 * соберётся и запустится, просто в настройках честно скажет, что обновляться ей
 * неоткуда. Это лучше, чем подставить выдуманный репозиторий и получить у
 * пользователя вечную ошибку проверки обновлений.
 *
 * Использование: electron-builder --config electron-builder.cjs
 */

const { execFileSync } = require('child_process');
const base = require('./electron-builder.json');

/** github.com/owner/repo в любом из привычных видов ссылки. */
function parseGitHubUrl(url) {
  const match = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(String(url).trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function fromEnvironment() {
  const owner = (process.env.WIREON_GH_OWNER || '').trim();
  const repo = (process.env.WIREON_GH_REPO || '').trim();
  return owner && repo ? { owner, repo } : null;
}

function fromGitRemote() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return parseGitHubUrl(url);
  } catch {
    // Репозитория нет, git не установлен, remote не настроен — все три случая
    // означают одно и то же: канала обновлений мы не знаем.
    return null;
  }
}

const target = fromEnvironment() || fromGitRemote();

if (target) {
  console.log(`[electron-builder] Канал обновлений: github.com/${target.owner}/${target.repo}`);
} else {
  console.log(
    '[electron-builder] Канал обновлений не задан (нет WIREON_GH_OWNER/WIREON_GH_REPO и git remote origin) — сборка будет без автообновления.'
  );
}

module.exports = target
  ? {
      ...base,
      publish: [
        {
          provider: 'github',
          owner: target.owner,
          repo: target.repo,
          // По умолчанию electron-builder создаёт черновик релиза, а черновик
          // для чужих приложений не виден — обновление никто бы не получил.
          releaseType: 'release'
        }
      ]
    }
  : base;
