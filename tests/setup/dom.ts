import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { installMockApi } from './mockApi';

// jsdom lacks these; components rely on them.
class RO { observe(): void {} unobserve(): void {} disconnect(): void {} }
Object.defineProperty(window, 'ResizeObserver', { value: RO, writable: true });
Object.defineProperty(window, 'IntersectionObserver', { value: RO, writable: true });
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }),
});
Element.prototype.scrollIntoView = vi.fn();
if (!('randomUUID' in crypto)) Object.defineProperty(crypto, 'randomUUID', { value: () => `${Math.random()}`.slice(2) });

beforeEach(() => {
  installMockApi();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
