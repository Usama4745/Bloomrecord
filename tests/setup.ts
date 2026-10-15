import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// React Testing Library only auto-cleans with Vitest globals enabled; do it explicitly.
afterEach(async () => {
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  }
});
