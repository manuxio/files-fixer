# files-fixer

Highlight and remediate file differences between two data roots in a
(potentially compromised) environment. It compares two SHA-256 checksum
manifests, groups the differences by website, and lets an operator inspect and
fix the **right** side — with every disruptive action backed up and logged to
`/evidence`.

- **added** (right only) · **modified** (sha256 differs) · **deleted** (left only)
- grouped by `<website_name>` (first path segment after `/mnt/data/`)
- per file: **diff · show left · show right · edit right in place · overwrite/restore right from left · delete right**
- syntax highlighting for `.php`, `.html`/`.htm`, `.js`
- every delete/overwrite/edit → `/evidence/audit.log` (JSONL) + a timestamped backup folder (`before`, `after`, `meta.json`)
- **multi-user**: all connected browsers update live (Server-Sent Events). Others' fixes/deletes/overwrites/edits appear immediately, and a presence marker shows who is viewing/editing each file — so two operators don't remediate the same thing twice.
- **Joomla core diff**: for a file that maps onto Joomla core, diff it against pristine upstream source (choose the version) to reveal injected code. Sources are mounted at `/joomla`; versions are auto-discovered.
- **JCE core diff**: for a file belonging to the JCE editor, **vs JCE** diffs it against the pristine JCE package the dropper installs (full 2.9.99.8 or the security patch) — extracted in-memory and matched by path — to spot code injected into JCE's own files.
- **Patch JCE (com_jce)**: one-click remediation of the vulnerable JCE editor — temporarily drops a token-gated remediation tool + the JCE 2.9.99.8 packages into a site's docroot, drives it over HTTP/HTTPS (optional Basic Auth), then removes them. Records each run in a persisted `patches.csv`, notifies other operators, and shows a `<patched>` label on the site root.
- **Bulk actions**: multi-select files within one website (checkboxes) to **mark fixed** or **delete** in one go.

---

## Run with Docker Compose

> **Port note:** the container listens on `3000`; compose publishes it on host
> port **`3001`** by default (port 3000 is often already in use). Override with
> `HOST_PORT`, e.g. `HOST_PORT=8088 docker compose up`.

### A) Build & run locally (works offline, no registry needed)

```bash
docker compose up --build
# open http://localhost:3001
```

### B) Run the prebuilt image from GHCR (built by GitHub Actions)

```bash
docker compose -f docker-compose.ghcr.yml up
# open http://localhost:3001
```

The image is published to `ghcr.io/manuxio/files-fixer:latest` on every push to
`main`. To pull it without authenticating, the GHCR package must be **public**
(Repo → Packages → the package → Package settings → Change visibility → Public),
otherwise first run `docker login ghcr.io`.

Stop / logs:

```bash
docker compose down
docker compose logs -f
```

Both compose files mount the bundled demo data under [`./sample`](sample/), so
you get a working dataset immediately (2 sites · 2 added · 3 modified · 1 deleted).

---

## Point it at real data

Edit the `volumes:` in `docker-compose.yml` (or `docker-compose.ghcr.yml`):

```yaml
volumes:
  - /path/to/trusted/root:/left:ro     # keep read-only — never modified
  - /path/to/investigated/root:/right  # writable — this is what you remediate
  - /path/to/evidence:/evidence        # writable — CSVs, audit.log, backups
```

`/evidence` must contain the two manifests (`left.csv`, `right.csv`) unless you
override `LEFT_CSV` / `RIGHT_CSV`.

### Container inputs

| Mount        | Purpose                          | Access |
|--------------|----------------------------------|--------|
| `/left`      | trusted / baseline data root     | **ro** |
| `/right`     | data root being remediated       | rw     |
| `/evidence`  | CSVs + `audit.log` + `backups/`  | rw     |
| `/joomla`    | pristine Joomla sources (one subfolder per version) | **ro** |

### Environment variables

| Var               | Default               | Meaning |
|-------------------|-----------------------|---------|
| `PORT`            | `3000`                | in-container port |
| `HOST_PORT`       | `3001`                | published host port (compose only) |
| `LEFT_ROOT`       | `/left`               | trusted mount |
| `RIGHT_ROOT`      | `/right`              | remediated mount |
| `EVIDENCE_ROOT`   | `/evidence`           | evidence mount |
| `LEFT_CSV`        | `/evidence/left.csv`  | left manifest |
| `RIGHT_CSV`       | `/evidence/right.csv` | right manifest |
| `CSV_PATH_PREFIX` | `/mnt/data`           | prefix stripped from `absolute_path` to map onto the mounts |
| `JOOMLA_ROOT`     | `/joomla`             | pristine Joomla sources root (one subfolder per version) |

CSV format: `absolute_path,filename,last_modified,size_bytes,sha256`, where
`absolute_path` starts with `<CSV_PATH_PREFIX>/<website>/…`. Path-traversal
outside a mount root is rejected.

---

## Compare against pristine Joomla core

When a changed file maps onto a Joomla core path, you can diff the live file
against the pristine upstream source to spot injected code, regardless of the
`left` baseline.

Mount your Joomla sources at `/joomla`, one subfolder per version — the folder
name is the version label shown in the UI:

```text
/joomla/
  Joomla-3.9.21/      # a full, pristine Joomla install
  Joomla-3.10.12/
  Joomla-4.4.4/
  Joomla-5.2.6/
```

Versions are auto-discovered (`GET /api/joomla/versions`). In the toolbar pick a
version and click **vs Joomla**: the app locates the matching core file (by
matching the path suffix, so it works whether Joomla is at the site root or in a
subfolder) and shows a synced diff of *pristine → current right file*. If the
path isn't part of that version's core, it says so (custom file / wrong version).

Populate `/joomla` with the official full packages (needs `curl` + `unzip`):

```bash
JOOMLA_ROOT=./sample/joomla ./scripts/fetch-joomla.sh 3.9.21 3.10.12 4.4.4 5.2.6
```

> Joomla trees are **not** baked into the image (that would add gigabytes). They
> are mounted, so you ship only the versions you actually need. The bundled demo
> ships two tiny stub versions (`3.9.21`, `3.10.11`) so the feature works out of
> the box.

---

## Evidence & audit trail

Every delete/overwrite/edit writes to `/evidence`:

- `audit.log` — append-only JSONL, one line per action (timestamp, operation,
  actor, before/after sha256 + size, backup folder, source path).
- `backups/<ts>__<op>__<path>/` — `before.<ext>`, `after.<ext>` (none for delete),
  and `meta.json`.

**An operator name is required** before any change-operation (delete / overwrite /
edit / mark-fixed): the server rejects unattributed changes (HTTP 400, before
touching any file) and the UI disables those actions until a name is set. The
name is stamped into every log line and backup. The in-app **History** button
renders the audit trail.

Reset the demo after testing:

```bash
node scripts/gen-sample.js
rm -rf sample/evidence/backups sample/evidence/audit.log
# then click "Refresh CSVs" in the UI
```

---

## Local dev (no Docker)

```bash
npm run setup                 # server + client deps
node scripts/gen-sample.js    # build ./sample demo data + CSVs
cp .env.example .env          # points at ./sample, any OS
npm run dev                   # server :3000 + Vite :5173 (proxied)
# open http://localhost:5173
```

## Generating manifests

`scripts/gen-csv.js` walks a directory and prints a manifest:

```bash
node scripts/gen-csv.js /path/to/root /mnt/data > left.csv
```

## Notes

- The diff is computed from the **CSVs** (the forensic snapshot); file views/edits
  read the **live** files. After remediation, findings stay listed and marked ✔
  handled — hit **Refresh CSVs** only if you regenerate the manifests.
- Large CSVs are **streamed** on the server — the whole file is never held in memory.
- The UI never transfers the whole dataset. It loads `GET /api/summary` (websites +
  counts only), then `GET /api/files?website=&status=&q=&offset=&limit=` on demand as
  you expand a group or search — so a huge manifest stays on the server and the browser
  only ever holds a page at a time.
