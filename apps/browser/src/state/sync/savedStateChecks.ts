import { isBaseEntry, isLogFile, isSequence, isSyncOp, isSyncRecord, type ScopeState } from "../../platform/sync";
import { isFields } from "../../lib/decode";
import type { SyncDoc } from "./syncDoc";
import type { JournalPart } from "./syncFiles";

export class SyncStateDamaged extends Error {
  readonly code = "ERR_SYNC_STATE_DAMAGED";
  readonly where: string;
  constructor(where: string) {
    super(`Sync's saved state is damaged (${where})`);
    this.name = "SyncStateDamaged";
    this.where = where;
  }
}

const everyValue = (v: unknown, valid: (item: unknown) => boolean) => isFields(v) && Object.values(v).every(valid);
const listOf = (v: unknown, valid: (item: unknown) => boolean) => Array.isArray(v) && v.every(valid);
const orAbsent = (v: unknown, valid: (item: unknown) => boolean) => v === undefined || valid(v);
const orDeleted = (valid: (item: unknown) => boolean) => (v: unknown) => v === null || valid(v);

function bookkeepingDamage(rest: Partial<ScopeState>): string | null {
  if (!orAbsent(rest.seq, isSequence)) return "seq";
  if (!orAbsent(rest.journal, (v) => listOf(v, isLogFile))) return "journal";
  if (!orAbsent(rest.outbox, (v) => listOf(v, isSyncOp))) return "outbox";
  if (!orAbsent(rest.vv, (v) => everyValue(v, isSequence))) return "vv";
  if (!orAbsent(rest.extra, (v) => everyValue(v, (list) => listOf(list, isSequence)))) return "extra";
  if (!orAbsent(rest.unapplied, (v) => listOf(v, (key) => typeof key === "string"))) return "unapplied";
  return null;
}

function scopeDamage(scoped: ScopeState): string | null {
  if (!everyValue(scoped.records, isSyncRecord)) return "a record";
  if (!everyValue(scoped.base, isBaseEntry)) return "a base entry";
  return bookkeepingDamage(scoped);
}

function changeDamage(change: unknown): string | null {
  if (!isFields(change) || !isFields(change.rest)) return "a change";
  if (!everyValue(change.records, orDeleted(isSyncRecord))) return "a changed record";
  if (!everyValue(change.base, orDeleted(isBaseEntry))) return "a changed base entry";
  return bookkeepingDamage(change.rest as Partial<ScopeState>);
}

export function savedStateDamage(scopes: SyncDoc["scopes"], parts: JournalPart[], covers: number, device: string | null, live: Set<string>): string | null {
  for (const [name, scoped] of Object.entries(scopes)) {
    const damage = scopeDamage(scoped);
    if (damage) return `${damage} in the checkpoint's ${name} scope`;
  }
  for (const part of parts) {
    if (part.id <= covers) continue;
    for (const [name, files] of Object.entries(part.journal ?? {})) if (!listOf(files, isLogFile)) return `a batch in journal part ${part.id} for ${name}`;
    if (!part.changes || part.device !== device) continue;
    for (const [name, change] of Object.entries(part.changes)) {
      const damage = live.has(name) ? changeDamage(change) : null;
      if (damage) return `${damage} in journal part ${part.id} for ${name}`;
    }
  }
  return null;
}
