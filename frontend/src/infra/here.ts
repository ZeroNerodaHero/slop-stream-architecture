import { inTauri } from './update-check.ts';

export const HERE = inTauri() ? 'this app' : 'this browser';
export const HERE_TITLE = inTauri() ? 'This app' : 'This browser';
