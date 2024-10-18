import { expect, vi } from 'vitest';
import { toReceiveCommandWith } from 'aws-sdk-client-mock-vitest';
import type { CustomMatcher } from 'aws-sdk-client-mock-vitest';

expect.extend({ toReceiveCommandWith });

// Mock console methods to prevent output during tests
vi.spyOn(console, 'error').mockReturnValue();
vi.spyOn(console, 'warn').mockReturnValue();
vi.spyOn(console, 'debug').mockReturnValue();
vi.spyOn(console, 'info').mockReturnValue();
vi.spyOn(console, 'log').mockReturnValue();

declare module 'vitest' {
  // biome-ignore lint/suspicious/noExplicitAny: vitest typings expect an any type
  interface Assertion<T = any> extends CustomMatcher<T> {}
  interface AsymmetricMatchersContaining extends CustomMatcher {}
}
