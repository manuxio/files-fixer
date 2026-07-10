// TypeScript model of the harmfulness-classifier rules.
//
// This is documentation, not compiled code — the server is plain CommonJS
// (see classify.js / rules.js). It describes the exact JSON shape persisted to
// <evidence>/classify.rules.json and accepted by the /api/rules CRUD endpoints.

// ────────────────────────────── patterns ──────────────────────────────

/** JSON can't hold a native RegExp, so regexes travel as { regex, flags }. */
export interface JsonRegex {
  /** Regex source, e.g. "eval\\s*\\(". */
  regex: string;
  /** Regex flags; defaults to "i" (case-insensitive). */
  flags?: string;
}

/** A `contains` pattern is a literal substring (case-insensitive) OR a regex. */
export type Pattern = string | JsonRegex;

/** Where in the file body a content pattern must be found. */
export type Where =
  | "top"   // first 512 bytes — a backdoor prepended to a legit file
  | "mid"   // everything after the first 512 bytes — an injected block deep down
  | "any";  // anywhere in the (sampled) body — the default

// ───────────────────────────── conditions ─────────────────────────────
// A rule fires when EVERY condition in its `all` array matches (logical AND).
// Within a single Condition object, every present key must also hold. Mix
// structural (manifest-tier, no file read) and content-tier keys freely.

export interface Condition {
  // ---- structural: path + extension (manifest tier) ----
  /** Extension is a server-executable script (php-family, phtml, cgi, …). */
  execExt?: boolean;
  /** Extension ∈ this list (lower-case, no dot), e.g. ["jpg","png"]. */
  ext?: string[];
  /** Change status of the file. */
  status?: "added" | "modified" | "deleted";
  /** Document-root-relative path is an upload/cache/media/tmp dir. */
  uploadDir?: boolean;
  /** Disguised or double extension (e.g. x.php.jpg, shell.phtml.). */
  disguised?: boolean;
  /** Sha256 matches a pristine Joomla/JCE source file (known-good). */
  knownGoodSha?: boolean;
  /** Document-root-relative path matches (regex only). */
  pathRe?: JsonRegex;
  /** File name matches (regex only). */
  nameRe?: JsonRegex;
  /** File name without extension matches (regex only). */
  stemRe?: JsonRegex;

  // ---- structural: distance from baseline (manifest tier) ----
  /** modified AND grew over baseline by ≤ its own size (append-shaped). */
  sizeGrew?: boolean;
  /** modified AND size changed wholesale (>4× or <0.3× baseline). */
  sizeReplace?: boolean;
  /** modified AND same size (±2 bytes) but a new hash (in-place tamper). */
  sizeSame?: boolean;

  // ---- content: body signatures (content tier — needs one file read) ----
  /** Body contains this pattern … */
  contains?: Pattern;
  /** … at this position. Only meaningful alongside `contains`. Default "any". */
  where?: Where;
  /** Shannon entropy of the body (bits/byte) is greater than n. */
  entropyOver?: number;
  /** Longest whitespace-free run in the body is longer than n chars. */
  tokenOver?: number;
}

// ─────────────────────────────── rules ────────────────────────────────

export type RuleKind =
  | "risk"        // weighted evidence (positive pushes up, negative pulls down)
  | "hardHit"     // clamp the final score to at least `floor`
  | "hardBenign"; // clamp the final score to at most `ceil`

interface RuleBase {
  /** Stable id. For a user rule, reusing a built-in id overrides that built-in. */
  id: string;
  /** Human-readable name shown in the UI and reasons list. */
  name: string;
  /** One-line rationale surfaced to the reviewer. */
  why?: string;
  /** Conditions, ANDed together. A rule with an empty `all` never fires. */
  all: Condition[];
  /** If true the rule is inert. On a built-in id this switches the built-in off. */
  disabled?: boolean;
}

export interface RiskRule extends RuleBase {
  kind: "risk";
  /**
   * Evidence weight in [-1, 1].
   *   (0, 1]  → harmful evidence, combined by noisy-OR (pushes the score up).
   *   [-1, 0) → BENIGN evidence (pulls the score down multiplicatively).
   */
  weight: number;
}

export interface HardHitRule extends RuleBase {
  kind: "hardHit";
  /** Score is clamped to be at least this (0..100). Wins over benign evidence. */
  floor: number;
}

export interface HardBenignRule extends RuleBase {
  kind: "hardBenign";
  /** Score is clamped to be at most this (0..100). */
  ceil: number;
}

export type Rule = RiskRule | HardHitRule | HardBenignRule;

/** The persisted user file is exactly this: a JSON array of rules. */
export type RulesFile = Rule[];

// ─────────────────────────── scoring output ───────────────────────────

export type Band = "low" | "elevated" | "high" | "critical";

export interface Reason {
  id: string;
  name: string;
  /** The rule's contribution: risk weight, or ±1 for a hard floor/ceiling. */
  weight: number;
  why?: string;
}

export interface Risk {
  /** 0..100 harmfulness suggestion. */
  score: number;
  band: Band;
  /** Which tier produced it: "manifest" (no read) or "content" (body read). */
  tier: "manifest" | "content";
  /** Top contributing rules, most significant first. */
  reasons: Reason[];
}
