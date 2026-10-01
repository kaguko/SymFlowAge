import { relations, sql } from 'drizzle-orm';
import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  real,
  customType,
  integer,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// PostgreSQL pgvector 768-dimension column definition for text-embedding-004
export const pgVector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(768)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    if (typeof value !== 'string') return [];
    try {
      return value
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map((v) => Number(v.trim()));
    } catch {
      return [];
    }
  },
});

// Users table for Firebase Auth synchronization
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// Notes & Documents table with pgvector semantic embeddings, 4 JSONB Indexing Strategies, & Stored Generated Column
export const notes = pgTable(
  'notes',
  {
    id: serial('id').primaryKey(),
    userUid: text('user_uid').notNull(),
    title: text('title').notNull(),
    category: text('category').notNull().default('Ghi chú'),
    content: text('content').notNull(),
    tags: text('tags').notNull().default(''),
    metadata: jsonb('metadata').$type<{
      priority?: string;
      framework?: string;
      techStack?: string[];
      architecture?: string;
      status?: string;
      metrics?: { difficulty?: number; impact?: number };
    }>().default({}),
    // PostgreSQL Stored Generated Column to avoid TOAST Tax on JSONB > 8KB
    extractedPriority: text('extracted_priority').generatedAlwaysAs(
      sql`metadata->>'priority'`
    ),
    isActive: boolean('is_active').notNull().default(true),
    embedding: pgVector('embedding'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    // Strategy 1: GIN (jsonb_ops) - Supports @>, ?, ?|, ?& (Full key existence & containment)
    ginOpsIdx: index('notes_metadata_gin_ops_idx').using('gin', table.metadata),

    // Strategy 2: GIN (jsonb_path_ops) - Supports ONLY @> (1/3 - 1/4 size, high-throughput document containment)
    ginPathOpsIdx: index('notes_metadata_gin_path_idx').using(
      'gin',
      sql`${table.metadata} jsonb_path_ops`
    ),

    // Strategy 3: Expression B-Tree - Supports =, <, >, BETWEEN, IN on scalar key extracted via ->>
    priorityBtreeIdx: index('notes_metadata_priority_btree_idx').on(
      sql`(${table.metadata}->>'priority')`
    ),

    // Strategy 4: Partial Index - Minimal storage overhead for filtered active records
    activeNotesGinIdx: index('notes_active_metadata_partial_idx')
      .using('gin', sql`${table.metadata} jsonb_path_ops`)
      .where(sql`${table.isActive} = true`),
      
    // Index on Stored Generated Column (Avoids TOAST decompression CPU overhead entirely)
    generatedPriorityIdx: index('notes_generated_priority_idx').on(table.extractedPriority),
  })
);

// High-Throughput Task Queue Table (Demonstrating FOR NO KEY UPDATE pattern)
export const taskQueue = pgTable(
  'task_queue',
  {
    id: serial('id').primaryKey(),
    noteId: serial('note_id').references(() => notes.id),
    taskPayload: jsonb('task_payload').default({}),
    status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'completed' | 'failed'
    workerId: text('worker_id'),
    lockedAt: timestamp('locked_at'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => ({
    statusIdx: index('task_queue_status_idx').on(table.status),
  })
);

export const predictions = pgTable(
  'predictions',
  {
    id: text('id').primaryKey(),
    userUid: text('user_uid').references(() => users.uid, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    context: jsonb('context').notNull(),
    payload: jsonb('payload').notNull(),
    driftProb: real('drift_prob').notNull(),
    crashProb: real('crash_prob').notNull(),
    flowProb: real('flow_prob').notNull(),
    predictedPath: text('predicted_path').notNull(),
    modelVersion: text('model_version'),
    promptVersion: text('prompt_version'),
    latencyMs: real('latency_ms'),
  },
  (table) => ({
    createdAtIdx: index('predictions_created_at_idx').on(table.createdAt),
    pathIdx: index('predictions_path_idx').on(table.predictedPath),
    userCreatedAtIdx: index('predictions_user_created_at_idx').on(table.userUid, table.createdAt),
  })
);

export const outcomes = pgTable(
  'outcomes',
  {
    id: text('id').primaryKey(),
    predictionId: text('prediction_id')
      .references(() => predictions.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),
    userUid: text('user_uid').references(() => users.uid, { onDelete: 'cascade' }),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).defaultNow().notNull(),
    actualPath: text('actual_path').notNull(),
    actualDriftScore: real('actual_drift_score'),
    source: text('source').notNull().default('auto'),
    notes: text('notes'),
  },
  (table) => ({
    evaluatedAtIdx: index('outcomes_evaluated_at_idx').on(table.evaluatedAt),
    predictionIdx: index('outcomes_prediction_idx').on(table.predictionId),
  })
);

// ── Billing: tenants, API keys (hash only) and metered usage ──────────────────────────────
export const tenants = pgTable(
  'tenants',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    name: text('name'),
    planId: text('plan_id').notNull().default('free'),
    status: text('status').notNull().default('active'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull().defaultNow(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    emailIdx: uniqueIndex('tenants_email_idx').on(table.email),
    stripeCustomerIdx: index('tenants_stripe_customer_idx').on(table.stripeCustomerId),
  })
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    name: text('name').notNull().default('default'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => ({
    keyHashIdx: uniqueIndex('api_keys_key_hash_idx').on(table.keyHash),
    tenantIdx: index('api_keys_tenant_idx').on(table.tenantId),
  })
);

export const billingUsage = pgTable(
  'billing_usage',
  {
    tenantId: text('tenant_id')
      .references(() => tenants.id, { onDelete: 'cascade' })
      .notNull(),
    periodKey: text('period_key').notNull(),
    route: text('route').notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.periodKey, table.route] }),
  })
);

export const usersRelations = relations(users, ({ many }) => ({
  notes: many(notes),
  predictions: many(predictions),
  outcomes: many(outcomes),
}));

export const notesRelations = relations(notes, ({ one }) => ({
  author: one(users, {
    fields: [notes.userUid],
    references: [users.uid],
  }),
}));
