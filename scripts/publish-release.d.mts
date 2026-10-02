/** Типы для `publish-release.mjs` — чтобы тест проверялся `tsc` наравне с остальными. */

export interface ReleaseAsset {
  name: string;
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  assets: ReleaseAsset[];
  html_url?: string;
}

export interface ReleaseApi {
  findRelease(tag: string): Promise<GitHubRelease | null>;
  createDraft(options: { tag: string; name: string; body: string; target?: string }): Promise<GitHubRelease>;
  publish(release: GitHubRelease): Promise<GitHubRelease>;
}

export function requiredWindowsAssets(version: string): string[];
export function missingAssets(release: { assets?: ReleaseAsset[] } | null | undefined, required: string[]): string[];
export function releaseNotes(changelogSource: string, version: string): string;
export function createGitHub(options: {
  token: string;
  owner: string;
  repo: string;
  fetchImpl?: typeof fetch;
}): ReleaseApi;
export function prepare(options: {
  github: ReleaseApi;
  version: string;
  notes: string;
  target?: string;
  log?: (message: string) => void;
}): Promise<GitHubRelease>;
export function publish(options: {
  github: ReleaseApi;
  version: string;
  required?: string[];
  log?: (message: string) => void;
}): Promise<GitHubRelease>;
