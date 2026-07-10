# Harmfulness classification — rules

files-fixer scores every changed file **0–100** for how likely it is to be
attacker-planted or injected, and surfaces that as **advice to the reviewer**.
It never acts on the score — it only reorders and flags. The human still decides
(and every destructive action stays operator-gated, backed up, and logged).

Classification is performed **entirely server-side** (`server/classify.js`); the
client just renders the `risk` object the server attaches to each file.

- The full TypeScript model lives in [`server/rules.types.d.ts`](server/rules.types.d.ts).
- Rules are stored as **JSON** at `<evidence>/classify.rules.json` (override with
  `CLASSIFY_RULES`) and can be created/edited/deleted **live** via `/api/rules`.

> **Note on samples.** To keep this documentation file from tripping
> signature-based antivirus, malicious snippets below are shown **defanged** —
> a code-execution function is written as the placeholder `‹sink›` and a decoder
> as `‹decoder›`. The exact literals the classifier matches live in
> [`server/classify.js`](server/classify.js).

---

## 1. How a file is scored

Two tiers, matching the app's data model — the diff is built from the CSV
manifests (path/size/sha only), file bodies are read lazily:

| Tier | Needs | When it runs |
|------|-------|--------------|
| **manifest** | path, extension, status, size/distance, known-good sha | for every changed file, at diff time (no file read) |
| **content**  | + body pattern-signatures + entropy | when the file is opened (`/api/file`); cached by content sha256 so byte-identical files are scanned once |

A file starts at its manifest score and **upgrades to the content score** the
first time its body is read. Because the content cache is keyed by sha, fixing
one file scores all of its byte-identical twins too.

### Combining rules

Each rule that fires contributes evidence. Evidence combines like this:

```
riskUp    = 1 − Π(1 − wᵢ)        for every fired risk weight wᵢ > 0   (noisy-OR)
benignDn  = 1 − Π(1 − |wⱼ|)      for every fired risk weight wⱼ < 0   (benign)
score     = 100 · riskUp · (1 − benignDn)
score     = min(ceil, score)     for every hardBenign rule            (clamp down)
score     = max(floor, score)    for every hardHit rule               (clamp up — wins)
score     = clamp(round(score), 0..100)
```

- **Noisy-OR** is order-independent, monotonic (more harmful evidence never
  lowers the score), and saturates toward 100 — so stacked weak signals add up
  without any single rule needing to be certain.
- **Negative weights are benign evidence** and pull the score *down*
  multiplicatively (e.g. a file byte-identical to pristine upstream).
- **Hard floors win ties** — a known webshell fingerprint (`floor 95`) can't be
  talked down by a benign rule; a hard ceiling caps an otherwise scary file.

### Bands

Bands drive the badge colour and are the reviewer-facing summary:

| Score | Band | Meaning |
|-------|------|---------|
| 80–100 | `critical` | almost certainly malicious — look first |
| 50–79 | `high` | strong signals; review closely |
| 20–49 | `elevated` | changed executable / weak signals |
| 0–19 | `low` | little/no signal (e.g. a plain deletion) |

Every score ships a **`reasons`** list (top contributors, most significant
first) so the number is explainable — the reviewer judges the suggestion, they
don't trust a bare number.

---

## 2. The rule model (TypeScript)

```ts
type Where = "top" | "mid" | "any";            // position of a content pattern
interface JsonRegex { regex: string; flags?: string; }  // JSON can't hold RegExp
type Pattern = string | JsonRegex;             // literal substring OR regex

interface Condition {
  // structural — manifest tier (no file read)
  execExt?: boolean;                 // extension is a server-executable script
  ext?: string[];                    // extension ∈ list, e.g. ["jpg","png"]
  status?: "added" | "modified" | "deleted";
  uploadDir?: boolean;               // docroot-relative path is an upload/cache dir
  disguised?: boolean;               // double / disguised extension
  knownGoodSha?: boolean;            // sha256 ∈ pristine Joomla/JCE index
  pathRe?: JsonRegex;                // docroot-relative path matches
  nameRe?: JsonRegex;                // filename matches
  stemRe?: JsonRegex;                // filename without extension matches
  sizeGrew?: boolean;                // modified & append-shaped growth
  sizeReplace?: boolean;             // modified & wholesale size change
  sizeSame?: boolean;                // modified & same size, new hash

  // content — content tier (needs the file body)
  contains?: Pattern;                // body contains pattern…
  where?: Where;                     // …at this position (default "any")
  entropyOver?: number;              // Shannon entropy (bits/byte) > n
  tokenOver?: number;                // longest whitespace-free run > n chars
}

type RuleKind = "risk" | "hardHit" | "hardBenign";

interface RuleBase { id: string; name: string; why?: string; all: Condition[]; disabled?: boolean; }
interface RiskRule       extends RuleBase { kind: "risk";       weight: number; } // (0,1] up · [-1,0) benign
interface HardHitRule    extends RuleBase { kind: "hardHit";    floor: number;  } // clamp ≥ floor
interface HardBenignRule extends RuleBase { kind: "hardBenign"; ceil: number;   } // clamp ≤ ceil

type Rule = RiskRule | HardHitRule | HardBenignRule;
type RulesFile = Rule[];               // the persisted JSON file is exactly this
```

A rule **fires when every condition in `all` matches** (logical AND). Keys
inside one condition object are also ANDed. **Mix freely** — structural + content
in the same rule is how "path + extension + pattern" rules are expressed.

---

## 3. Conditions reference

| Key | Tier | Fires when |
|-----|------|-----------|
| `execExt` | manifest | extension is a server-executable script (`php`, `phtml`, `pht`, `phar`, `inc`, `cgi`, `pl`, `py`, `asp`, `jsp`, `sh`, …) |
| `ext` | manifest | extension is in the given list |
| `status` | manifest | file is `added` / `modified` / `deleted` |
| `uploadDir` | manifest | docroot-relative path is under `uploads`, `cache`, `media`, `images`, `tmp`, `files`, `assets`, `backups`, … |
| `disguised` | manifest | double/disguised extension (e.g. a script masquerading as an image, or a trailing dot/space) |
| `knownGoodSha` | manifest | content sha256 matches a pristine Joomla/JCE source file |
| `pathRe` | manifest | docroot-relative path matches the regex |
| `nameRe` | manifest | filename matches the regex |
| `stemRe` | manifest | filename **without extension** matches the regex |
| `sizeGrew` | manifest | `modified` and grew over baseline by ≤ its own size (append-shaped) |
| `sizeReplace` | manifest | `modified` and size changed wholesale (>4× or <0.3×) |
| `sizeSame` | manifest | `modified` and same size ±2 bytes but a new hash |
| `contains` | content | body contains the pattern (string = substring, else regex) at `where` |
| `where` | content | position for `contains`: `top` / `mid` / `any` |
| `entropyOver` | content | body Shannon entropy (bits/byte) exceeds `n` |
| `tokenOver` | content | longest whitespace-free run exceeds `n` chars |

### Paths are document-root-relative

Path/`uploadDir`/`pathRe` conditions match the path **relative to the site's
document root** — the `<website>` segment is stripped. So a live file at
`/mnt/data/example.com/uploads/x.php` is matched as `uploads/x.php`.

### Positions (`where`)

The "very top" is the **first 512 bytes** of the file (≈ the first 8 lines);
"mid" is everything after that. This distinguishes:

- `where: "top"` — a backdoor **prepended** to an otherwise-legit file
  (a `<?php @‹sink›($_POST[…]) ?>` one-liner on line 1 of `index.php`).
- `where: "mid"` — a payload **injected deep** inside normal code
  (`@‹sink›($_GET[…])` on line 1500 of a big module).
- `where: "any"` — anywhere in the sampled body (the default).

---

## 4. Rule kinds & negative rules

- **`risk`** — weighted evidence. `weight ∈ (0, 1]` is harmful (noisy-OR up).
  `weight ∈ [-1, 0)` is **benign** and pulls the score down. A benign rule is
  just a `risk` rule with a negative weight.
- **`hardHit`** — clamps the score to **at least `floor`**. Use for
  near-certain findings (a shell in an upload dir, a known fingerprint). Floors
  win over benign evidence.
- **`hardBenign`** — clamps the score to **at most `ceil`**. Use for
  definitive allow-listing.

### Known-good sha

The `known-good-sha` built-in is a **negative** rule: any file whose content
sha256 matches a pristine **Joomla core** (`JOOMLA_ROOT`, one subfolder per
version) or **JCE package** file is treated as legitimate upstream — even if it
differs from the local `left` baseline (a legit core update). The index is built
in the background on startup; check `GET /api/rules` → `knowngood: {ready,size}`.

---

## 5. Built-in catalog

29 rules ship by default. Signatures are described here, not quoted verbatim —
see [`server/classify.js`](server/classify.js) for the exact patterns.

| id | name | kind | weight / clamp | conditions (ANDed) |
|----|------|------|----------------|--------------------|
| `exec-script` | Executable script | risk | 0.18 | `execExt` |
| `script-in-upload-dir` | Script in upload/cache dir | risk | 0.75 | `execExt` + `uploadDir` |
| `added-script` | New script (not in baseline) | risk | 0.40 | `execExt` + `status:added` |
| `disguised-ext` | Disguised / double extension | risk | 0.70 | `disguised` |
| `suspicious-name` | Suspicious filename | risk | 0.55 | `execExt` + `stemRe` (webshell-family or hash-like stem) |
| `htaccess` | Server-config file | risk | 0.40 | `nameRe` (.htaccess/.user.ini) |
| `injection-growth` | Grew over baseline | risk | 0.28 | `sizeGrew` |
| `wholesale-replace` | Wholesale size change | risk | 0.20 | `sizeReplace` |
| `subtle-inplace` | In-place tamper | risk | 0.15 | `sizeSame` |
| `super-to-sink` | Request input → exec/eval | risk | 0.80 | `contains` request-input flowing into a code-exec sink |
| `include-backdoor` | include() of decoded payload | risk | 0.80 | `contains` `include(‹decoder›(…` |
| `exec-sink` | Code-execution sink | risk | 0.50 | `contains` a code-exec sink call |
| `preg-replace-e` | preg_replace /e | risk | 0.70 | `contains` a `preg_replace(…/e)` code-exec |
| `create-function` | create_function() | risk | 0.50 | `contains` `create_function(` |
| `decoder` | Obfuscation decoder | risk | 0.45 | `contains` a base64/gzinflate-style decoder |
| `uploader` | Upload / write primitive | risk | 0.50 | `contains` an upload / arbitrary-write primitive |
| `var-var` | Variable-variable | risk | 0.30 | `contains` `${'…'}` indirection |
| `high-entropy-blob` | High-entropy blob | risk | 0.40 | `entropyOver:5.6` + `tokenOver:500` |
| `prepended-backdoor` | Backdoor at top of file | risk | 0.60 | `execExt` + `contains` exec-sink **`where:top`** |
| `deep-injection` | Injection mid-file | risk | 0.35 | `execExt` + `contains` exec-sink **`where:mid`** |
| `js-cookie-exfil` | Cookie exfiltration | risk | 0.80 | `contains` `document.cookie` + `contains` a network sender |
| `js-eval-decode` | eval(atob(…)) | risk | 0.60 | `contains` `‹sink›(atob/unescape(…` |
| `foreign-script` | Injected external script | risk | 0.35 | `contains` an injected external `<script src>` |
| `hidden-iframe` | Hidden iframe | risk | 0.40 | `contains` a hidden `<iframe>` |
| `shell-in-upload` | Shell in upload dir | **hardHit** | floor 92 | `execExt` + `uploadDir` + `contains` exec-sink |
| `polyglot` | Polyglot (script as media) | **hardHit** | floor 90 | `!execExt` + `ext:[media]` + `contains` `<?php` `where:top` |
| `known-shell` | Known webshell fingerprint | **hardHit** | floor 95 | `contains` a well-known public webshell family marker |
| `htaccess-enables-php` | .htaccess enables PHP | **hardHit** | floor 80 | `nameRe` + `contains` a directive that (re-)enables PHP |
| `known-good-sha` | Matches pristine source | risk | **−0.97** | `knownGoodSha` |

---

## 6. Persistence & precedence

- User rules persist as a JSON array (`RulesFile`) at
  `<evidence>/classify.rules.json`.
- **Precedence:** effective set = built-ins, with each built-in optionally
  overridden or disabled by a user rule of the **same `id`**, plus any user-only
  rules.
  - Override a built-in → add a user rule with that `id` and real conditions.
  - Disable a built-in → `{ "id": "<builtin-id>", "disabled": true }` (a stub;
    re-enabling removes the stub, keeping the file clean).
- A rule with an empty `all` never fires (so a disable-stub is inert).
- Any rule change **clears the content-score cache**, so scores recompute live.

---

## 7. Live CRUD API

All writes require an operator name (header `x-operator:` or `operator` in the
body) and are broadcast to other operators over SSE (event `rules`) + written to
the audit log.

| Method & path | Body | Effect |
|---------------|------|--------|
| `GET /api/rules` | — | `{ builtins, user, overrides, file, knowngood }` |
| `POST /api/rules` | `{ rule: Rule }` | create or update a user rule (by `id`) |
| `POST /api/rules/disable` | `{ id, disabled }` | switch a rule (incl. a built-in) on/off |
| `DELETE /api/rules/:id` | — | delete a user rule (built-ins can only be disabled) |

Incoming rules are sanitized: `kind` defaults to `risk`, `weight` is clamped to
`[-1, 1]`, `floor`/`ceil` to `[0, 100]`, and a missing `id` is generated from
the name.

---

## 8. Examples

**Allow-list a trusted path (negative rule):**

```json
{
  "id": "trust-vendor-cache",
  "name": "Trust vendor cache",
  "kind": "risk",
  "weight": -0.9,
  "why": "operator-reviewed, generated cache",
  "all": [{ "pathRe": { "regex": "^cache/vendor/", "flags": "i" } }]
}
```

**Flag a campaign marker string near the top of any file:**

```json
{
  "id": "campaign-marker",
  "name": "Known dropper header",
  "kind": "risk",
  "weight": 0.5,
  "all": [{ "contains": "/* GENERATED */", "where": "top" }]
}
```

**Mix path + extension + pattern into a hard hit:**

```json
{
  "id": "php-in-images-writes-files",
  "name": "PHP in /images that writes files",
  "kind": "hardHit",
  "floor": 95,
  "all": [
    { "execExt": true },
    { "pathRe": { "regex": "^images/" } },
    { "contains": { "regex": "file_put_contents|fwrite" } }
  ]
}
```

**Definitively allow-list a specific file (hard ceiling):**

```json
{
  "id": "allow-known-tool",
  "name": "Approved admin tool",
  "kind": "hardBenign",
  "ceil": 0,
  "all": [{ "nameRe": { "regex": "^adminer-approved\\.php$" } }]
}
```
