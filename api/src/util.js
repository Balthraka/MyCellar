// Errors, JSON replies and body reading come from the shared core, so the core's dispatcher recognises the app's errors.
// Only app-specific helpers are defined here.
export { HttpError, bad, conflict, json, readJson } from '../core/index.js';

export const nowMs = () => Date.now();
