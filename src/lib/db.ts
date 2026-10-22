import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL tanımlı değil");
  return drizzle(postgres(url, { prepare: false }), { schema });
}

let connection: ReturnType<typeof connect> | undefined;
export const db = new Proxy({} as ReturnType<typeof connect>, {
  get(_target, property) {
    connection ??= connect();
    const value = Reflect.get(connection, property);
    return typeof value === "function" && property !== "$client" ? value.bind(connection) : value;
  },
});

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
