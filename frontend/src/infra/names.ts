/** Stream names: lowercase letters, digits, _ and -. 1 to 32 chars. Same rule as api and video. */
const NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Names the fake streams of `video dummy` use. Only the dummy box can publish them. */
const DUMMY_PREFIX = 'dummy-';

export function cleanName(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase();
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

export function isDummyName(name: string): boolean {
  return name.startsWith(DUMMY_PREFIX);
}
