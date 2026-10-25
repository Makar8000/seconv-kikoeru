/** GitHub requires one; it names this app, nothing more. */
export const USER_AGENT = "seconv-kikoeru";

export type Asset = { name: string; browser_download_url: string; size: number };
export type Release = { tag_name: string; prerelease: boolean; draft: boolean; assets: Asset[] };

/** Lists a GitHub repository's releases, newest first. */
export const fetchReleases = async (url: string, signal?: AbortSignal): Promise<Release[]> => {
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT }, signal });
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status} ${res.statusText} while listing releases.`);
  }
  return res.json();
};

/** Downloads a release asset to `file`, streamed. */
export const downloadAsset = async (asset: Asset, file: string, signal?: AbortSignal) => {
  const res = await fetch(asset.browser_download_url, { headers: { "user-agent": USER_AGENT }, signal });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  await Bun.write(file, res);
};
