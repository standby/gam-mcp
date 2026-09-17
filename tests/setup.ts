import { afterEach, expect } from 'vitest';
import { takeViolations } from './fake-gam.js';

// H7 (spec §7.2): across the whole suite, a fake GAM receives no write other
// than creating or running a report. The test that sent one fails here.
afterEach(() => {
  expect(takeViolations(), 'requests the client must never send').toEqual([]);
});
