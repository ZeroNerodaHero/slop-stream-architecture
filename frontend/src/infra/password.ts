/**
 * The rule for a new password (signup, change), the api's `clean_new_password` in
 * api/src/auth.rs: nfkc first, then 8 to 128 characters with at least one number and one
 * symbol (anything not a letter, a number or a space). Logging in asks none of this, so a
 * password made before the rule still works. The api checks it again: this is the inline hint.
 */
export const NEW_PASSWORD_RULE = '8 to 128 characters, with at least one number and one symbol';

const MIN = 8;
const MAX = 128;

/** The rule's three parts, each met or not: the signup form's checklist. */
export interface PasswordChecks {
  length: boolean;
  number: boolean;
  symbol: boolean;
}

/** How many characters the rule counts: after nfkc, by code point. */
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

/** Every part of the rule met. */
export function passwordOk(checks: PasswordChecks): boolean {
  return checks.length && checks.number && checks.symbol;
}

/** What is missing from a new password, in words for under the box, or null when it is fine. */
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
