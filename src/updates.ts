/**
 * Lets people know when a new release is out. It reads the public GitHub
 * releases API; nothing is sent about you or your notes.
 */
export const REPO = "nathanksou/monkeynotes";
export const VERSION: string = __APP_VERSION__;

export interface Release {
  version: string;
  url: string;
}

function parse(v: string): number[] {
  return v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  // Same numbers: the final release is newer than a pre-release such as 0.4.0-beta.1.
  return /-/.test(current) && !/-/.test(candidate);
}

/** The latest release if it is newer than this build, otherwise null. */
export async function checkForUpdate(): Promise<Release | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`github returned ${res.status}`);
  const data = (await res.json()) as { tag_name?: string; html_url?: string };
  if (!data.tag_name || !isNewer(data.tag_name, VERSION)) return null;
  return { version: data.tag_name.replace(/^v/, ""), url: data.html_url ?? `https://github.com/${REPO}/releases` };
}
