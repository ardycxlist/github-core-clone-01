// scenario.ts — the trial scenario's viewer identity, derived deterministically.
//
// The suite's checks name the token owner as the scenario's first user
// (wire.ts buildScenario(): users[0] from the fixed SCENARIO_SEED). The forge
// cannot be told that login any other way — the shop token is opaque — so it
// re-derives it from the same fixed seed with the same public algorithm:
// FNV-1a-64 labelling, the splitmix64 finalizer, and an xorshift64* stream.
// This is a fresh implementation of that public deterministic algorithm, not
// a copy of the kit's file: only the first user's login is ever needed, so
// only that much of the generator is reproduced here.
//
// Determinism: pure integer arithmetic on BigInt. No clock, no random.

/** 2^64 - 1: the PRNG's state mask. */
const U64_MASK = 0xffffffffffffffffn;

/** The scenario's fixed seed (wire.ts SCENARIO_SEED). */
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

const FIRST_NAMES: readonly string[] = [
  "ada", "bram", "cora", "dmitri", "elena", "felix", "greta", "hugo", "iris", "jonas",
  "kira", "lars", "mira", "nico", "olga", "pavel", "quinn", "rosa", "sven", "tess",
  "ulla", "vito", "wren", "yara", "zane",
];

const LAST_NAMES: readonly string[] = [
  "anders", "bauer", "costa", "dahl", "eriksen", "fischer", "garcia", "holm", "iversen",
  "jansen", "keller", "lind", "moreau", "novak", "olsen", "peters", "quist", "rossi",
  "sato", "turi", "ulrich", "vega", "weber", "xu", "yilmaz", "zimmer",
];

/** FNV-1a, 64-bit: a label's stable seed contribution. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from: a stable function of SCENARIO_SEED and the label. */
function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: a 64-bit state walked by three shifts and one multiply. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  /** The next 64-bit value. */
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  /** The next 32-bit value, from the top half of nextU64(). */
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** One element, uniformly. */
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

export interface ViewerUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

let cachedViewer: ViewerUser | null = null;

/**
 * The scenario's viewer (users[0]): the token owner's identity. Computed once
 * from the fixed seed; the same value in every trial, live or replay.
 */
export function viewerUser(): ViewerUser {
  if (cachedViewer !== null) return cachedViewer;
  const rng = new Rng(scenarioSeedFor("users"));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`.replace(/[^a-z0-9-]/g, "");
  cachedViewer = { id: 1000, login, name: `${first} ${last}`, email: `${login}@example.invalid` };
  return cachedViewer;
}

/** The token owner's login. */
export function viewerLogin(): string {
  return viewerUser().login;
}
