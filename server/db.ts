import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

neonConfig.webSocketConstructor = ws;

export const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : undefined as unknown as Pool;

export const db = process.env.DATABASE_URL
  ? drizzle({ client: pool as Pool, schema })
  : undefined as unknown as ReturnType<typeof drizzle>;

if (!process.env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.warn("DATABASE_URL is not set; falling back to in-memory storage.");
}
