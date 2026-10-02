/**
 * Release on GitHub in two steps around electron-builder: a draft first, the
 * published release only once every file the updater needs is in it.
 *
 * Why. electron-builder uploads the installer, its .blockmap and latest.yml in
 * parallel, and when the release does not exist yet each upload asks GitHub to
 * create it. GitHub accepts the first and refuses the second ("Published
 * releases must have a valid tag" / 422), the build stops, and latest.yml never
 * lands. That happened again on 2.2.6: the release looked fine — installer on
 * the page — and no installed copy would ever have seen it. latest.yml had to
 * be written and uploaded by hand.
 *
 * With a draft already there, electron-builder finds it and only uploads —
 * there is nothing left to race over. A draft is invisible to the desktop
 * updater and to the phone (both read `releases/latest`), so nobody catches a
 * half-filled release in the minute the uploads take. `publish` then checks
 * the files are really there and flips the draft public.
 *
 *     node scripts/publish-release.mjs prepare    # before electron-builder
 *     node scripts/publish-release.mjs publish    # after it
 *
 * Needs GH_TOKEN in the environment, like `npm run release` itself.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';

/** Files a Windows release is useless without: the updater reads latest.yml first. */
export function requiredWindowsAssets(version) {
  return [`Wireon-Setup-${version}.exe`, `Wireon-Setup-${version}.exe.blockmap`, 'latest.yml'];
}

/** Missing names, in the order they are listed. */
export function missingAssets(release, required) {
  const present = new Set((release?.assets || []).map((asset) => asset.name));
  return required.filter((name) => !present.has(name));
}

/**
 * «Что нового» from src/data/changelog.ts as the release text, so the page on
 * GitHub says the same as the app. Plain Markdown; empty when the entry is not
 * found — a release without notes is still a release.
 */
export function releaseNotes(changelogSource, version) {
  const start = changelogSource.indexOf(`version: '${version}'`);
  if (start < 0) return '';
  const next = changelogSource.indexOf("version: '", start + 1);
  const block = changelogSource.slice(start, next < 0 ? undefined : next);
  const unquote = (value) => value.replace(/\\'/g, "'");
  const headline = /headline:\s*'((?:[^'\\]|\\.)*)'/.exec(block)?.[1];
  const items = [...block.matchAll(/title:\s*'((?:[^'\\]|\\.)*)'(?:,\s*detail:\s*'((?:[^'\\]|\\.)*)')?/g)].map(
    ([, title, detail]) => `- **${unquote(title)}**${detail ? ` — ${unquote(detail)}` : ''}`
  );
  return [headline ? unquote(headline) : '', '', ...items].join('\n').trim();
}

/** Owner and repo — the same answer electron-builder.cjs gives the build. */
function releaseTarget() {
  const require = createRequire(import.meta.url);
  const config = require(path.join(ROOT, 'electron-builder.cjs'));
  const github = (config.publish || []).find((entry) => entry.provider === 'github');
  if (!github) {
    throw new Error('No release channel: set WIREON_GH_OWNER/WIREON_GH_REPO or a GitHub git remote (see RELEASE.md).');
  }
  return { owner: github.owner, repo: github.repo };
}

export function createGitHub({ token, owner, repo, fetchImpl = fetch }) {
  const request = async (method, url, body) => {
    const res = await fetchImpl(url.startsWith('http') ? url : `${API}/repos/${owner}/${repo}${url}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${url}: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  };

  return {
    /** The release for this tag, drafts included (the list shows them to the owner). */
    async findRelease(tag) {
      const releases = await request('GET', '/releases?per_page=50');
      return releases.find((release) => release.tag_name === tag) || null;
    },
    createDraft({ tag, name, body, target }) {
      return request('POST', '/releases', {
        tag_name: tag,
        name,
        body,
        draft: true,
        prerelease: false,
        ...(target ? { target_commitish: target } : {})
      });
    },
    publish(release) {
      return request('PATCH', `/releases/${release.id}`, { draft: false, make_latest: 'true' });
    }
  };
}

/**
 * Makes sure a draft for this version exists. A release that is already
 * public is left alone and reported — uploading into it is what the old flow
 * did, and `publish` will still check it is complete.
 */
export async function prepare({ github, version, notes, target, log = console.log }) {
  const tag = `v${version}`;
  const existing = await github.findRelease(tag);
  if (existing) {
    log(`[release] ${tag}: ${existing.draft ? 'draft already exists — uploading into it' : 'already published — uploading into it'}`);
    return existing;
  }
  const draft = await github.createDraft({ tag, name: version, body: notes, target });
  log(`[release] ${tag}: draft created — not visible to anyone until it is published`);
  return draft;
}

/** Publishes the draft once the updater's files are all in it; refuses otherwise. */
export async function publish({ github, version, required = requiredWindowsAssets(version), log = console.log }) {
  const tag = `v${version}`;
  const release = await github.findRelease(tag);
  if (!release) throw new Error(`${tag}: no release found — run "prepare" first.`);
  const missing = missingAssets(release, required);
  if (missing.length > 0) {
    throw new Error(
      `${tag} is missing ${missing.join(', ')}. The release stays a draft: without latest.yml no installed copy would update. ` +
        'Re-run npm run release — it uploads into the same draft.'
    );
  }
  if (!release.draft) {
    log(`[release] ${tag}: already published, all files in place`);
    return release;
  }
  const published = await github.publish(release);
  log(`[release] ${tag}: published — ${published.html_url || ''}`);
  return published;
}

async function main() {
  const step = process.argv[2];
  if (step !== 'prepare' && step !== 'publish') {
    console.error('Usage: node scripts/publish-release.mjs <prepare|publish>');
    process.exit(1);
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('\n  GH_TOKEN is not set. See RELEASE.md — the token lives only in the environment.\n');
    process.exit(1);
  }
  const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const github = createGitHub({ token, ...releaseTarget() });

  if (step === 'prepare') {
    let target;
    try {
      target = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
      target = undefined; // no git (e.g. a container copy): GitHub tags the default branch
    }
    const notes = releaseNotes(readFileSync(path.join(ROOT, 'src/data/changelog.ts'), 'utf8'), version);
    await prepare({ github, version, notes, target });
  } else {
    await publish({ github, version });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
