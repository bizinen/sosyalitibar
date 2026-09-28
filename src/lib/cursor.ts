export type ItemCursor = { at: Date; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeItemCursor(cursor: ItemCursor): string {
  return Buffer.from(JSON.stringify({ at: cursor.at.toISOString(), id: cursor.id }), "utf8").toString("base64url");
}

export function decodeItemCursor(value?: string | null): ItemCursor | null {
  if (!value || value.length > 500) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { at?: unknown; id?: unknown };
    if (typeof parsed.at !== "string" || typeof parsed.id !== "string" || !UUID_RE.test(parsed.id)) return null;
    const at = new Date(parsed.at);
    if (!Number.isFinite(at.getTime())) return null;
    return { at, id: parsed.id };
  } catch {
    return null;
  }
}
