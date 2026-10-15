import { defineConfig } from 'drizzle-kit';

// `npm run db:generate` writes new SQL migrations; register each one in
// electron/storage/migrations/index.ts so it is bundled into the app.
export default defineConfig({
  dialect: 'sqlite',
  schema: './electron/storage/schema.ts',
  out: './electron/storage/migrations',
});
