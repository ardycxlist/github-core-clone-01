// store.ts — deterministic state for the forge.
//
// Determinism rules (non-negotiable):
//   - No wall-clock reads and no unseeded random anywhere in forge code.
//   - All timestamps come from MAKEFUN_TRIAL_NOW (an ISO string the trial
//     sets) or a fixed epoch when the variable is absent (local dev).
//   - All ids come from sequential counters.
//   - All iteration whose order affects output is sorted.

export const ZERO_OID = "0000000000000000000000000000000000000000";

export type GitObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null; // bound on first path reference (first-owner-wins)
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // ref name -> oid
  createdSeq: number;
}

/**
 * Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
 * Pure integer arithmetic — no Date object anywhere in the forge.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const TRIAL_NOW_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

function parseTrialNow(): { iso: string; epochSec: number } {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const m = TRIAL_NOW_ISO.exec(raw);
    if (m) {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      const hour = Number(m[4]);
      const minute = Number(m[5]);
      const second = Number(m[6]);
      const epochSec =
        daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second;
      const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
      return { iso, epochSec };
    }
  }
  return { iso: "2026-01-01T00:00:00Z", epochSec: 1767225600 };
}

const TRIAL_NOW = parseTrialNow();

/** ISO timestamp for REST payloads (fixed for the whole trial). */
export function trialNowIso(): string {
  return TRIAL_NOW.iso;
}

/** Epoch seconds for git commit timestamps (fixed for the whole trial). */
export function trialNowEpochSec(): number {
  return TRIAL_NOW.epochSec;
}

/** The trial seed, when set (opaque; never used to derive names). */
export function trialSeed(): string | undefined {
  return process.env.MAKEFUN_TRIAL_SEED;
}

export class Store {
  reposByName = new Map<string, Repo>();
  private repoSeq = 10000;
  private requestSeq = 0;

  /** Next deterministic request id (X-GitHub-Request-Id header). */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner: null,
      description,
      isPrivate,
      defaultBranch: "main",
      objects: new Map(),
      refs: new Map(),
      createdSeq: this.repoSeq,
    };
    this.repoSeq += 1;
    this.reposByName.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.reposByName.get(name);
  }

  /**
   * Resolve a repo for a path reference under `owner`.
   * - Repo missing -> undefined.
   * - Repo unbound -> bind it to `owner` (first-owner-wins) and return it.
   * - Repo bound to a different owner -> undefined (foreign owner = 404).
   */
  resolveRepo(name: string, owner: string): Repo | undefined {
    const repo = this.reposByName.get(name);
    if (!repo) return undefined;
    if (repo.owner === null) {
      repo.owner = owner;
      return repo;
    }
    if (repo.owner !== owner) return undefined;
    return repo;
  }
}
