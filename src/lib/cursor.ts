export type ItemCursor = { at: Date; id: string; preciseAt?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeItemCursor(cursor: ItemCursor): string {
  return Buffer.from(JSON.stringify({ at: cursor.preciseAt ?? cursor.at.toISOString(), id: cursor.id }), "utf8").toString("base64url");
}

export function decodeItemCursor(value?: string | null): ItemCursor | null {
  if (typeof value !== "string" || !value || value.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { at?: unknown; id?: unknown };
    if (typeof parsed.at !== "string" || typeof parsed.id !== "string" || !UUID_RE.test(parsed.id)) return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(parsed.at)) return null;
    const at = new Date(parsed.at);
    if (!Number.isFinite(at.getTime()) || at.toISOString() !== parsed.at.replace(/(\.\d{3})\d{3}Z$/, "$1Z")) return null;
    return { at, id: parsed.id, ...(parsed.at.length === 27 ? { preciseAt: parsed.at } : {}) };
  } catch {
    return null;
  }
}
