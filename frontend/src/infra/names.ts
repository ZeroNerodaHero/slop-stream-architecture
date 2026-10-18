/** Stream names: lowercase letters, digits, _ and -. 1 to 32 chars. Same rule as api and video. */
const NAME_RE = /^[a-z0-9_-]{1,32}$/;

export function cleanName(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}
