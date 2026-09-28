import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL tanımlı değil");

const client = postgres(url, { prepare: false });
export const db = drizzle(client, { schema });
