type Level = "info" | "warn" | "error";

type Fields = Record<string, unknown>;

function clean(fields: Fields): Fields {
  const blocked = /token|secret|password|authorization|cookie|payload|raw/i;
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !blocked.test(key)));
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
