type Level = "info" | "warn" | "error";

function write(level: Level, message: string, details?: unknown): void {
  const timestamp = new Date().toISOString();
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (message: string, details?: unknown) => write("info", message, details),
  warn: (message: string, details?: unknown) => write("warn", message, details),
  error: (message: string, details?: unknown) => write("error", message, details)
};
