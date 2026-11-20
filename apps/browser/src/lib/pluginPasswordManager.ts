import { isFields } from "./decode";

export const PASSWORD_FIELDS = ["login", "oneTimeCode"] as const;
export type PasswordField = (typeof PASSWORD_FIELDS)[number];
export const PASSWORD_FILLS = ["system"] as const;
export const RESERVED_PASSWORD_FILLS = ["tool"] as const;
export const PASSWORD_FIELD_COUNT = [1, 2] as const;
export const PASSKEY_STORES = ["host"] as const;
export const RESERVED_PASSKEY_STORES = ["plugin"] as const;
export const PASSKEY_IMPORTS = ["appleCredentialExchange"] as const;
export type PasskeyImport = (typeof PASSKEY_IMPORTS)[number];
export type PasskeyProviderSpec = { store: "host"; import: PasskeyImport[]; create: boolean };
export type PasswordManagerSpec = {
  fill: "system";
  fields: PasswordField[];
  verificationCodeSetup: "system" | null;
  passkeys: "system" | null;
  passkeyProvider: PasskeyProviderSpec | null;
};

const KEYS = ["fill", "fields", "verificationCodeSetup", "passkeys", "passkeyProvider"];
const PROVIDER_KEYS = ["store", "import", "create"];
const PATH = "passwordManager";

function systemOnly(problems: string[], key: string, value: unknown): "system" | null {
  if (value === undefined) return null;
  if (value === "system") return "system";
  problems.push(`${PATH}.${key} must be system`);
  return null;
}

function fillOf(problems: string[], value: unknown): "system" | null {
  if (value === "system") return "system";
  if ((RESERVED_PASSWORD_FILLS as readonly unknown[]).includes(value)) problems.push(`${PATH}.fill: ${String(value)} isn't available yet; use system`);
  else problems.push(`${PATH}.fill must be system`);
  return null;
}

function fieldsOf(problems: string[], value: unknown): PasswordField[] {
  const [least, most] = PASSWORD_FIELD_COUNT;
  if (!Array.isArray(value) || value.length < least || value.length > most) {
    problems.push(`${PATH}.fields must be a list of ${least} to ${most} of ${PASSWORD_FIELDS.join(", ")}`);
    return [];
  }
  const fields: PasswordField[] = [];
  value.forEach((f, i) => {
    if (!(PASSWORD_FIELDS as readonly unknown[]).includes(f)) problems.push(`${PATH}.fields[${i}] must be ${PASSWORD_FIELDS.join(" or ")}`);
    else if (fields.includes(f as PasswordField)) problems.push(`${PATH}.fields has ${String(f)} twice`);
    else fields.push(f as PasswordField);
  });
  return fields;
}

function passkeyImportsOf(problems: string[], value: unknown): PasskeyImport[] {
  const path = `${PATH}.passkeyProvider.import`;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${path} must be a list of ${PASSKEY_IMPORTS.join(", ")}`);
    return [];
  }
  const imports: PasskeyImport[] = [];
  value.forEach((source, i) => {
    if (!(PASSKEY_IMPORTS as readonly unknown[]).includes(source)) problems.push(`${path}[${i}] must be ${PASSKEY_IMPORTS.join(" or ")}`);
    else if (imports.includes(source as PasskeyImport)) problems.push(`${path} has ${String(source)} twice`);
    else imports.push(source as PasskeyImport);
  });
  return imports;
}

function passkeyProviderOf(problems: string[], value: unknown): PasskeyProviderSpec | null {
  const path = `${PATH}.passkeyProvider`;
  if (value === undefined) return null;
  if (!isFields(value)) {
    problems.push(`${path} must be an object`);
    return null;
  }
  for (const key of Object.keys(value)) if (!PROVIDER_KEYS.includes(key)) problems.push(`${path}.${key} isn't a key of ${path}`);
  const before = problems.length;
  if (value.store !== "host") {
    if ((RESERVED_PASSKEY_STORES as readonly unknown[]).includes(value.store)) problems.push(`${path}.store: ${String(value.store)} isn't available yet; use host`);
    else problems.push(`${path}.store must be host`);
  }
  const imports = passkeyImportsOf(problems, value.import);
  if (value.create !== undefined && typeof value.create !== "boolean") problems.push(`${path}.create must be true or false`);
  return problems.length === before ? { store: "host", import: imports, create: value.create !== false } : null;
}

export function passwordManagerOf(problems: string[], value: unknown): PasswordManagerSpec | null {
  if (value === undefined) return null;
  if (!isFields(value)) {
    problems.push(`${PATH} must be an object`);
    return null;
  }
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) problems.push(`${PATH}.${key} isn't a key of ${PATH}`);
  const fill = fillOf(problems, value.fill);
  const fields = fieldsOf(problems, value.fields);
  const verificationCodeSetup = systemOnly(problems, "verificationCodeSetup", value.verificationCodeSetup);
  const passkeys = systemOnly(problems, "passkeys", value.passkeys);
  const passkeyProvider = passkeyProviderOf(problems, value.passkeyProvider);
  return fill && fields.length ? { fill, fields, verificationCodeSetup, passkeys, passkeyProvider } : null;
}
