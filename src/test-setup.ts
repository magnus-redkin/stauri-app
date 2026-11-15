import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Mock i18n so t() returns the key itself (tests locate text by key)
vi.mock('$lib/i18n', () => ({
  i18n: {
    t: (key: string) => key,
    locale: 'en',
  },
  loadTranslations: vi.fn().mockResolvedValue({}),
  // Add any further i18n exports that get imported here
}));
