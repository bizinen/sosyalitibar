type Level = "info" | "warn" | "error";

type Fields = Record<string, unknown>;

function redact(value: string): string {
  let text = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (/token|secret|password|api_key|database_url/i.test(key) && secret && secret.length >= 8) {
      text = text.split(secret).join("[redacted]").split(encodeURIComponent(secret)).join("[redacted]");
    }
  }
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/((?:access_token|client_secret|api_key|authorization|password)\s*[:=]\s*["']?)[^\s&,;"']+/gi, "$1[redacted]");
}

export function safeErrorMessage(error: unknown, maxLength = 1200): string {
  if (!(error instanceof Error)) return "Operation failed";
  if (error.message.startsWith("Failed query:")) return "Database operation failed";
  if (error.name === "ZodError") return "Provider output contract invalid";
  return redact(error.message).slice(0, maxLength);
}

function clean(fields: Fields, depth = 0): Fields {
  const blocked = /token|secret|password|authorization|cookie|payload|raw/i;
  if (depth > 5) return {};
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !blocked.test(key) && !/^(ts|level|event)$/.test(key)).map(([key, value]) => [key,
    typeof value === "string" ? redact(value).slice(0, 2000)
      : value instanceof Error ? safeErrorMessage(value)
      : Array.isArray(value) ? value.slice(0, 50).map((item) => typeof item === "string" ? redact(item).slice(0, 2000) : item && typeof item === "object" ? clean(item as Fields, depth + 1) : item)
      : value && typeof value === "object" ? clean(value as Fields, depth + 1) : value,
  ]));
}

function write(level: Level, event: string, fields: Fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...clean(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const log = {
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};
