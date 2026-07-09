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

CSV format: `absolute_path,filename,last_modified,size_bytes,sha256`, where
`absolute_path` starts with `<CSV_PATH_PREFIX>/<website>/…`. Path-traversal
outside a mount root is rejected.

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
