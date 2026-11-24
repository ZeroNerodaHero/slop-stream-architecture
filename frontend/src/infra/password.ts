export const NEW_PASSWORD_RULE = '8 to 128 characters, with at least one number and one symbol';

const MIN = 8;
const MAX = 128;

export interface PasswordChecks {
  length: boolean;
  number: boolean;
  symbol: boolean;
}

function countOf(raw: string): number {
  return [...raw.normalize('NFKC')].length;
}

export function passwordChecks(raw: string): PasswordChecks {
  const password = raw.normalize('NFKC');
  const length = [...password].length;
  return {
    length: length >= MIN && length <= MAX,
    number: /\p{N}/u.test(password),
    symbol: /[^\p{Alphabetic}\p{N}\p{White_Space}]/u.test(password)
  };
}

export function passwordOk(checks: PasswordChecks): boolean {
  return checks.length && checks.number && checks.symbol;
}

export function newPasswordProblem(raw: string): string | null {
  const { length: lengthOk, number, symbol } = passwordChecks(raw);
  if (!lengthOk) {
    const length = countOf(raw);
    return length < MIN ? `at least ${MIN} characters (${length} so far)` : `at most ${MAX} characters`;
  }
  if (!number && !symbol) return 'add a number and a symbol, like 7 and !';
  if (!number) return 'add a number';
  if (!symbol) return 'add a symbol, like ! or #';
  return null;
}
