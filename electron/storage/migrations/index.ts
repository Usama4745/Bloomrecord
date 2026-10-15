import init from './0000_init.sql?raw';

/**
 * Migrations bundled into the app, in order. Generate new ones with
 * `npm run db:generate` and append them here. Never edit an applied migration.
 */
export const MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [{ id: '0000_init', sql: init }];
