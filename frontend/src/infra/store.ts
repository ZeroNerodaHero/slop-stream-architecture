import { getDefaultStore } from 'jotai';

/**
 * The one Jotai store. Action functions read and write through it; components subscribe
 * with the hooks, which use the same default store when there is no Provider.
 */
export const store = getDefaultStore();
