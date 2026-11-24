const NAME_RE = /^[a-z0-9_-]{1,32}$/;

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
