import { createArtifactPort } from './artifact.js';
import { canonicalPath } from './canonical-path.js';
import type { EvidenceRecord, HostLedgerPort } from './host-ledger.js';
import { formatActivityId, parseActivityId } from './square-core.js';
import { validateName } from './model.js';
import { hostLedgerForEnv } from './registry.js';

/**
 * Explicit host-ledger evidence maintenance.
 *
 * Old wake/presentation rows are retired only when a typed artifact snapshot proves the
 * recipient's attention is permanently closed: the activity reached them historically, and
 * either catch recorded a receipt or the recipient joined again past it. Everything else is
 * retained. Artifacts are read directly, one snapshot per canonical location, outside any
 * ledger lock; retirement is the ledger's exact-record compare-and-swap. No SQL lives here.
 */

/** A row is old enough to consider once its landing time is at least this far behind now. */
const RETIREMENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The two host-ledger capabilities maintenance uses; no parallel ledger contract is owned here. */
type MaintenanceLedger = Pick<HostLedgerPort, 'listEvidence' | 'retireEvidenceIfUnchanged'>;

export interface LedgerMaintenanceOptions {
  /** Prove eligible rows without retiring anything. */
  readonly dryRun?: boolean;
  readonly now?: number;
}

/**
 * Counts are retired rows, not reclaimed bytes: SQLite reuses freed storage without necessarily
 * shrinking its file. Retired Claude correlations leave indefinite recognition tokens; total
 * token count remains unbounded. Maintenance does not run VACUUM.
 */
export interface LedgerMaintenanceReport {
  readonly dryRun: boolean;
  /** Old rows whose closure proof passed; exact-record CAS may still refuse. */
  readonly eligible: number;
  /** Rows actually removed by this run; always 0 in a dry run. */
  readonly retired: number;
  /** Eligible rows whose full-record compare-and-swap refused; always 0 in a dry run. */
  readonly casMisses: number;
  /** Canonical locations whose artifact could not be read; their rows were retained. */
  readonly unavailableArtifacts: readonly string[];
}

interface Candidate {
  readonly record: EvidenceRecord;
  readonly index: number;
}

/** The canonical activity coordinate the row names; leading zeros and other spellings are invalid. */
function activityIndex(activity: string): number | undefined {
  const index = parseActivityId(activity);
  return index === undefined || formatActivityId(index) !== activity ? undefined : index;
}

/** Old, durably closed-looking wake/presentation rows with usable coordinates. */
function isCandidate(record: EvidenceRecord, now: number): boolean {
  if (record.kind !== 'wake' && record.kind !== 'presentation') return false;
  if (record.outcome === 'dispatching') return false;
  if (typeof record.at !== 'number' || !Number.isFinite(record.at) || record.at > now - RETIREMENT_AGE_MS) return false;
  if (typeof record.location !== 'string' || record.location.length === 0) return false;
  try {
    validateName(record.participant);
  } catch {
    return false;
  }
  return true;
}

/**
 * One artifact snapshot for one location either proves each candidate closed or reports the
 * whole location unavailable. A missing, unreadable, or non-artifact path returns undefined
 * and its rows are retained.
 */
async function provenClosable(location: string, group: readonly Candidate[]): Promise<readonly Candidate[] | undefined> {
  const artifact = createArtifactPort(location);
  try {
    return (await artifact.read((facts) => group.filter((candidate) => {
      const participant = candidate.record.participant;
      if (facts.directedAt(participant, candidate.index) === undefined) return false;
      if (facts.receipt(participant, candidate.index) !== undefined) return true;
      const lastJoin = facts.participant(participant)?.lastJoinIndex;
      return lastJoin !== undefined && lastJoin > candidate.index;
    }))).value;
  } catch {
    return undefined;
  } finally {
    await artifact.close();
  }
}

/** Command/application entry: root selection uses the caller's captured environment. */
export function gcHostLedger(options: LedgerMaintenanceOptions & { readonly env?: NodeJS.ProcessEnv } = {}): Promise<LedgerMaintenanceReport> {
  return maintainHostLedger(hostLedgerForEnv(options.env ?? process.env), options);
}

export async function maintainHostLedger(
  ledger: MaintenanceLedger,
  options: LedgerMaintenanceOptions = {},
): Promise<LedgerMaintenanceReport> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? Date.now();
  const records = await ledger.listEvidence({ includeReleased: true, includeExpired: true, now });

  const groups = new Map<string, Candidate[]>();
  for (const record of records) {
    if (!isCandidate(record, now)) continue;
    const index = activityIndex(record.activity);
    if (index === undefined) continue;
    const location = await canonicalPath(record.location).catch(() => undefined);
    if (location === undefined) continue;
    const group = groups.get(location);
    if (group === undefined) groups.set(location, [{ record, index }]);
    else group.push({ record, index });
  }

  let eligible = 0;
  let retired = 0;
  let casMisses = 0;
  const unavailable = new Set<string>();

  for (const location of [...groups.keys()].sort()) {
    const closable = await provenClosable(location, groups.get(location)!);
    if (closable === undefined) {
      unavailable.add(location);
      continue;
    }
    eligible += closable.length;
    if (dryRun) continue;
    for (const candidate of closable) {
      if (await ledger.retireEvidenceIfUnchanged(candidate.record)) retired += 1;
      else casMisses += 1;
    }
  }

  return { dryRun, eligible, retired, casMisses, unavailableArtifacts: [...unavailable].sort() };
}
