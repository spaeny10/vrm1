// ============================================================
// Barrel module — the database layer lives in server/db/*.js,
// split by domain. This file re-exports everything so existing
// `import { ... } from './db.js'` statements keep working.
// ============================================================

export * from './db/core.js';
export * from './db/schema.js';
export * from './db/telemetry.js';
export * from './db/settings.js';
export * from './db/embeddings.js';
export * from './db/jobsites.js';
export * from './db/notes.js';
export * from './db/crm.js';
export * from './db/audit.js';
export * from './db/assignments.js';
export * from './db/maintenance.js';
export * from './db/analytics.js';
export * from './db/energy.js';
export * from './db/alerts.js';
export * from './db/users.js';
export * from './db/actions.js';
export * from './db/notifications.js';
export * from './db/rentals.js';
