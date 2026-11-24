export interface Counted {
  name: string;
  followers: number;
  following: boolean;
}

export function recount<T extends Counted>(list: T[], name: string, following: boolean): T[] {
  return list.map((p) => (p.name === name && p.following !== following ? { ...p, following, followers: Math.max(0, p.followers + (following ? 1 : -1)) } : p));
}
