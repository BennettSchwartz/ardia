import { queueLog, type ConsentToken } from "./client";
import { knownErrorCode, knownErrorMessage } from "./knownErrors";
import { LOG_TEMPLATES } from "./logTemplates";
import { errorType, scrubText } from "./sanitize";
import { matchTemplate } from "./templates";

const MAX_DISTINCT = 40;
const UNLISTED = "unlisted";
const seen = new Set<string>();

export { errorFor, logConsent, warnFor } from "./consoleConsent";

export function recordLog(level: "warn" | "error", args: unknown[], consent: ConsentToken | null) {
  const first = args[0];
  if (typeof first !== "string" || !first.trim()) return;
  const template = matchTemplate(first, LOG_TEMPLATES);
  const error = args.slice(1).find((a) => a instanceof Error);
  const type = error ? errorType(error) : "none";
  const reason = error ? knownErrorMessage(error) : "";
  const code = error ? knownErrorCode(error) : null;
  const key = `${scrubText(first, 160)}\n${type}\n${reason}\n${code ?? ""}`;
  if (seen.has(key) || seen.size >= MAX_DISTINCT) return;
  seen.add(key);
  const attributes: Record<string, string> = { error_type: type };
  if (template) attributes.log_template = template[0];
  if (reason) attributes.error_message = reason;
  if (code) attributes.error_code = code;
  queueLog(level, template?.[1] ?? UNLISTED, attributes, consent, first);
}
