# Ingestion Rescue — API & Behavior

> The rescue surface: the localhost endpoints a wrapper calls to inspect and
> quiesce a stuck ingestion round (**API**, below), and **what the pipeline
> itself does** when a resumed round finds its durable state broken
> (**Behavior**, below). This is the operational reference; the *why* (root
> cause, design trade-offs, the round-start identity contract) lives in
> [`ingestion-recovery-design.md`](./ingestion-recovery-design.md). When the
> two disagree, the code wins — re-verify and update this file.

Grounded in `kl_server.py` (`/ingest/recovery-info`, `/ingest/stop`,
`/ingest/backup`, `/ingest/restore`, `/status`), `kl_graph/ingest/recovery.py`
(`classify_recovery`, `SkipRoundError`), `kl_graph/ingest/pipeline.py`
(`_maybe_heal_missing_workset`, `_load_workset`),
`kl_graph/ingest/runner.py` (`run_ingestion` skip branch), and
`kl_graph/storage/snapshot.py` (`copy_path`) plus each store's
`checkpoint()` / `snapshot_paths()`. Verified end-to-end on a real-data rig
(Case B → skip → accumulate).

---

## API

All rescue endpoints are **localhost-only** and intended for the desktop
wrapper. Server-local paths — `store_paths` (returned by recovery-info/stop) and
the `dest_dir`/`src_dir` of backup/restore — are handled only over localhost and
**never logged** (AGENTS.md §1). All return `503` when the server is not ready.

### `GET /ingest/recovery-info` (read-only)

Reports the current/last round's identity and a coarse recovery tier. Takes no
action.

```json
{
  "ingestion_id": "<batch_id or empty>",
  "round_started_at": 1786635320,
  "store_paths": ["<abs-path to knowledge.db>", "..."],
  "recovery_tier": "ok" | "resume" | "cleanup"
}
```

- `recovery_tier` comes from the A/B/C/D classifier (see **Behavior**): `resume`
  for Cases A/B-with-source, `cleanup` for Cases C/D/B-source-gone, `ok`
  otherwise. It is a **pre-flight hint**, not the final verdict — a `resume`
  round can still turn into a skip once the empty-workset condition is
  discovered at load time (Case B′ below).
- The tier strings are a stable contract with the wrapper; they are not renamed.

#### What "next round" / "next ingest" means

Throughout this doc, recovery happens on **the next `POST /ingest` for the same
`source_id`** — nothing else triggers it, and in particular **`POST /ingest/stop`
is not required** (stop is orthogonal; see below). The tier is a pre-flight hint
about what *that* call will do.

Two request facts decide resume-vs-skip; the rest of the request body does not:

- **`source_id` is the checkpoint key.** `classify_recovery` looks up the
  checkpoint `WHERE source_id=?` (`recovery.py`), so the next ingest must target
  the **same `source_id`** to see this recovery state at all. A different
  `source_id` is a different namespace — its own tier, usually `ok`.
- **`source_hash` (a stat-based fingerprint of the source export dir) decides
  resume vs. fresh round** on load (`checkpoint.py`, `_load`): if the hash
  **matches**, the interrupted round resumes (done steps are skipped); if it
  **differs**, the checkpoint normally resets to a fresh `batch_id` — **except**
  once Phase A has committed (`phase_a.persist_chunks=done`) and the round is not
  yet `ingest.complete`, the committed durable workset is the retry authority and
  the round resumes **even if the source changed**.
- **Other params are irrelevant to recovery.** `concurrency` and `improve_mode`
  do not affect the tier, nor resume-vs-skip. They only shape the run once it
  proceeds.

So: after a crash (OOM / kill -9 / power loss), the operator just re-issues
`POST /ingest` with the same `source_id`. A `cleanup`-tier round will
auto-**skip** (graph preserved, `checkpoint.reset()`), and the round after that
accumulates cleanly. No stop, no `--fresh-db`.

### `POST /ingest/stop` (graceful quiesce)

Cancels the running ingest task (waits up to 30 s), then closes all SQLite /
Kuzu / vector handles so the wrapper can copy or restore store files that are
not mid-write. Returns the identity alongside the quiesce result:

```json
{
  "quiesced": true,
  "detail": "all DB handles released",
  "ingestion_id": "<batch_id>",
  "round_started_at": 1786635320,
  "store_paths": ["<abs-path>", "..."]
}
```

`/ingest/stop` is the **only** rescue action endpoint — there is no
`stop-and-cleanup` or any destructive variant. It is reversible: it cancels the
task and releases handles, nothing more. Restarting the server resumes the same
round normally; the round identity and workset are untouched.

Note that stop is rarely needed for *recovery*: the A/B/C/D cases below
**self-heal or skip on their own** on the next round. Its real purpose is to let
the wrapper take control of the store files — quiesce, copy or restore, then
resume — or to halt a wedged/hung job.

### `POST /ingest/backup` (crash-consistent snapshot)

Copies the live stores into a caller-provided server-local directory, producing
a **self-contained, crash-consistent** snapshot. The caller (wrapper) owns
retention, location, and naming; kl owns only the copy mechanics and the
single-writer barrier that makes the copy consistent.

Request:

```json
{ "dest_dir": "/abs/server-local/path/snap-<ingestion_id>" }
```

Response:

```json
{
  "ingestion_id": "<batch_id or empty>",
  "round_started_at": 1786635320,
  "dest_dir": "/abs/server-local/path/snap-<ingestion_id>",
  "copied": [
    {"name": "knowledge.db", "bytes": 1234567},
    {"name": "graph.ladybug", "bytes": 890123},
    {"name": "zvec_data", "bytes": 4567890}
  ],
  "skipped": ["extraction_cache.db"],
  "bytes": 6692580
}
```

- **What is copied** is each store's `snapshot_paths()` — `knowledge.db` (+ its
  `-wal`/`-shm` sidecars if present), the graph backend file (+ `.wal` on
  ladybug), and the vector directory (main + community). Sidecars already
  truncated by the pre-copy `checkpoint()` are simply absent from `copied`.
- **`extraction_cache.db` is excluded structurally, not by a filter.** No store
  returns it from `snapshot_paths()`, so neither backup nor restore ever touches
  it. It is a content-addressed extraction accelerator (`cache_key` derives from
  `chunk_id` + a model/prompt/strategy/schema fingerprint), rebuildable and safe
  to leave in place. The `skipped` field is documentation only.
- **Crash-consistent, not transactional.** The four stores are not cross-engine
  transactional, so the snapshot may be logically split mid-round. That is
  sufficient: a restored snapshot is treated exactly like a post-crash state and
  handled by the A/B/C/D classifier + `SkipRoundError` (see **Behavior**) — a
  split round skips, the graph is preserved. No 2PC.
- **The single-writer barrier.** The single-flight ingest/improve queue is the
  only writer to the graph and vector stores; SQLite backup is natively
  concurrency-safe. Backup therefore runs only when no ingest/improve task is in
  flight, and blocks new ones while it runs (see status codes below). **Backup
  and restore are mutually exclusive** — both hold the same `backup_active`
  barrier, so two backups, two restores, or a backup racing a restore can never
  overlap. Each store is `checkpoint()`-ed (flush-without-close: SQLite
  `wal_checkpoint(TRUNCATE)`, ladybug bare `CHECKPOINT`, zvec per-collection
  `flush()`) before the copy so the copied files are self-consistent.
- **Copy mechanism.** Best-effort copy-on-write reflink (Linux `FICLONE`, macOS
  `clonefile`) with a `shutil.copy2`/`copytree` fallback; **all-or-nothing** — a
  disk-headroom pre-check (need × 1.1) and any copy failure fail loudly (never a
  half-written snapshot; AGENTS.md §4). On failure only the artifacts this
  request created are removed — a caller-provided `dest_dir` containing unrelated
  files is preserved (the endpoint never `rmtree`s the whole directory).

Status codes: `503` not ready · `409` an ingest/improve job is active (retry
after it finishes), or another backup/restore is in progress · `400` `dest_dir`
is not absolute, or already contains snapshot files (kept self-contained/clean) ·
`500` insufficient headroom or a copy failure (only this request's artifacts are
removed; the caller's other files in `dest_dir` are left intact).

`dest_dir` is **never logged** (AGENTS.md §1).

### `POST /ingest/restore` (quiesce → swap → in-process reopen)

Restores a prior snapshot in place and reopens the stores **without restarting
the process**. All stores are plain on-disk files that each engine opens at
startup, so restore is: close handles → swap files → reopen.

Request:

```json
{ "src_dir": "/abs/server-local/path/snap-<ingestion_id>" }
```

Response:

```json
{
  "restored": true,
  "src_dir": "/abs/server-local/path/snap-<ingestion_id>",
  "reopened": true,
  "restored_items": ["knowledge.db", "graph.ladybug", "zvec_data"],
  "skipped": ["extraction_cache.db"]
}
```

- **Sequence:** validate → `_quiesce()` (cancel any task, close all handles) →
  **move-aside** each existing target to `<name>.restore-old-<ts>` → copy the
  snapshot elements in → reopen via the shared `_bootstrap_stores()` (the same
  build path lifespan uses, so restore and cold start can never drift) →
  `ready=True`.
- **Failure is recoverable.** If any copy fails, restore deletes the partial new
  files, renames the move-aside copies back, and **still** reopens the stores on
  the original data before returning `500`. The move-aside copies are kept until
  `_bootstrap_stores()` has reopened successfully — so even if the *reopen* fails
  (a corrupt or incompatible snapshot), restore closes the partial handles, rolls
  the originals back, and reopens on the original data. The server never wedges in
  `ready=False` on a half-swapped data directory.
- **`extraction_cache.db` is left untouched** — even if `src_dir` contains one,
  it is ignored (structural exclusion, as in backup).
- **Ladybug WAL note.** The snapshot is copied *after* `checkpoint()` drained the
  `.wal`, so the restored `(graph.ladybug, .wal)` pair is self-consistent and
  reopens cleanly.

#### If a restore is killed mid-swap (hard crash, not a handled error)

The failure-recoverable path above covers *exceptions* during restore. It does
**not** cover the process being **killed** (SIGKILL / OOM / power loss) while
restore is between move-aside and reopen — the barrier is in-memory, and the
data directory is left half-swapped. Two facts make this safe to recover from:

- Restore **never overwrites originals in place**. It renames each original to
  `<name>.restore-old-<ts>` and copies the snapshot into a fresh path; the aside
  copies are deleted **only after** a successful reopen. So a kill can never
  reach that deletion — **your original data always survives on disk** in the
  `*.restore-old-<ts>` copies.
- On the next start, the server runs an **interrupted-restore guard** *before*
  opening any handle (crucial, because `sqlite3.connect` would otherwise
  silently create an empty `knowledge.db`). If it finds leftover
  `*.restore-old-*` copies **and** the live `knowledge.db` is missing / empty /
  corrupt, it **refuses to start** and logs the recovery steps rather than
  booting on empty data (a silent-degradation trap — AGENTS.md §4). If the live
  `knowledge.db` is healthy (restore succeeded, only cleanup was interrupted), it
  logs a warning about the leftovers and starts normally without touching disk.

The guard's decision is a function of two facts only — whether leftover
`*.restore-old-*` copies exist, and whether the live `knowledge.db` is usable
(opened read-only so the probe itself never auto-creates a file, then
`PRAGMA quick_check` + presence of the core `chunks` table):

| Leftover `*.restore-old-*` | Live `knowledge.db` | Startup |
|----------------------------|---------------------|---------|
| none | any | **Normal start** — no interrupted restore to recover. |
| present | healthy (real DB, `chunks` present) | **Warn + start**, disk untouched — restore succeeded, only cleanup was interrupted; operator removes the leftovers when convenient. |
| present | missing | **Refuse + print recovery steps** — killed after move-aside, before the copy landed. |
| present | empty (auto-created, no `chunks` table) | **Refuse** — this is the exact silent-empty-boot trap the guard exists to stop. |
| present | corrupt / truncated / half-copied | **Refuse** — killed mid-copy; the target is a partial file. |

The guard **never mutates disk** — it only reads, then either starts or refuses.
Recovery (below) is manual and deliberate, because the operator, not the server,
decides which copy is authoritative. This matrix is exercised against real DB
bytes in `tests/unit/test_interrupted_restore_guard.py`.

**Recovery when the guard refuses to start** (all under the data directory):
1. Delete the partially-copied target(s) — `knowledge.db` and any snapshot files
   the interrupted restore had just copied in.
2. Rename each `<name>.restore-old-<ts>` back to `<name>`.
3. Restart the server; **or** after step 1, restart and re-issue
   `POST /ingest/restore` with a good snapshot.

Do **not** delete the `*.restore-old-*` copies until recovery succeeds — they are
the only intact copy of the pre-restore data.

Status codes: `503` not ready · `409` an ingest/improve job is active (stop it
first), or a backup/restore is already in progress · `400` `src_dir` is not
absolute, is not a directory, or is missing a required element (`knowledge.db`;
`graph.ladybug` on the ladybug backend; the vector directory — required only when
the active vector store keeps local files, i.e. not a remote qdrant) — checked
**before** quiesce so a bad request never closes handles · `500` copy or reopen
failed (rolled back, stores reopened on original data).

`src_dir` is **never logged** (AGENTS.md §1).

### Backup / restore failure modes at a glance

Both endpoints fail **loudly and recoverably** — never a half-written snapshot,
never a wedged `ready=False`, never a silent empty boot (AGENTS.md §4). One
reference for every way a backup or restore can go wrong:

| When | What went wrong | What the server does | Left on disk |
|------|-----------------|----------------------|--------------|
| Backup | `dest_dir` not absolute, or already holds snapshot files | `400` before any copy | caller's `dest_dir` untouched |
| Backup | insufficient disk headroom (need × 1.1 pre-check) | `500`, no copy attempted | only this request's artifacts removed; caller's other files kept |
| Backup | copy fails mid-way | `500`, half-written targets removed | caller's unrelated files kept; barrier cleared in `finally` |
| Backup | an ingest/improve job is active, or another backup/restore is running | `409`, no action | live stores untouched |
| Restore | `src_dir` not absolute / not a dir / missing a required element | `400` **before** quiesce | handles never closed, live data untouched |
| Restore | an ingest/improve job is active, or a backup/restore is running | `409`, no action | live stores untouched |
| Restore | copy or reopen fails (e.g. corrupt snapshot) | rolls back move-aside, reopens on original data, then `500` | originals restored; no `*.restore-old-*` leftovers; barrier cleared |
| Restore | process **killed** mid-swap (SIGKILL / OOM / power loss) | in-memory barrier lost; next start runs the interrupted-restore guard (matrix above) | originals survive as `*.restore-old-*`; manual recovery |

The only case needing manual intervention is the last one — a hard kill during
the swap window. Every *handled* error (400/409/500) leaves the server running on
its original data with no leftovers.

### Who owns what

kl owns the **round identity** (`ingestion_id` + `round_started_at`, minted
together at round start), a **graceful quiesce** (`/ingest/stop`), and now the
**crash-consistent copy/restore mechanics** (`/ingest/backup`,
`/ingest/restore`, keyed by the caller's `dest_dir`/`src_dir`). The **wrapper
still owns policy** — whether and when to snapshot, where snapshots live,
retention, and naming (conventionally filed under `ingestion_id`). `store_paths`
from `/ingest/recovery-info` and `/ingest/stop` remains available for a wrapper
that prefers to copy files itself while kl is quiesced.

### Observing outcomes: `GET /status` and `GET /ingest/{run_id}/failures`

`GET /status` returns an `ingest` object mirroring the latest `ingest_runs` row:

| Field | Meaning |
|-------|---------|
| `state` | `idle` / `running` / `done` / `error` |
| `outcome` | `success` / `partial` / `skipped` |
| `warning` | skip reason or partial-extraction summary; empty on clean success |
| `detail` | human-readable terminal note (e.g. `round skipped: …`) |
| `units_processed`, `chunks_created`, `extraction_*` | per-round counts |
| `failures_url` | `/ingest/{run_id}/failures` when `extraction_failed > 0` |

A **skipped** round always shows `state='done'`, `outcome='skipped'`, a `warning`
containing the skip reason + a snapshot-restore hint, and **never** the string
`--fresh-db`.

`GET /ingest/{run_id}/failures?limit=&cursor=` returns the bounded, cursor-paged
extraction-failure manifest for one run (`extraction_item_id`, `source_unit_id`,
`target_chunk_id`, `error_type`, `message`, `attempts`) with a `next_cursor`.
This covers **partial** outcomes (extraction failures), which are distinct from
**skipped** rounds (unrecoverable workset).

---

## Behavior

What the pipeline does on its own when a resumed round finds its durable state
broken. The API above lets a wrapper observe and quiesce; the logic below is
automatic and needs no wrapper call.

## The one thing to remember

The main deployment is **high-frequency incremental ingestion**, so the graph is
a long-lived accumulation. Rescue is therefore biased toward **protecting the
accumulated graph**, never rebuilding it:

- **Resume** when the interrupted round can be safely reconstructed.
- **Skip the round** (complete-with-warning, graph untouched) when it cannot.
- **Never auto-suggest `--fresh-db`.** It is a real, deliberate manual
  full-database rebuild flag — but as *recovery advice* it would destroy the
  long-lived graph, so recovery advice is always "skip this round; restore a
  snapshot if that round's data is needed."
- **Never silently degrade.** A skipped round is recorded as
  `state='done'` **with a warning** in `ingest_runs`, so the loss is observable
  (AGENTS.md §4), not a silent "0 rows, all good".

---

## Two failure axes

1. **A missing/broken durable workset** (`ingest_batches` row gone or corrupt)
   while the checkpoint still says a chunk-dependent phase is due. This is what
   the A/B/C/D classifier handles. See below.
2. **A phase that died after the workset was committed** (e.g. extraction
   crashed). The workset row is intact and `state='ready'`, so the pipeline just
   hydrates it and resumes from the first unfinished step — this is an ordinary
   resume, not a rescue case.

---

## Case matrix (missing/broken workset)

`classify_recovery(conn, source_id, source_dir)` reads durable state only
(checkpoint row, `ingest_batches`, chunk count, whether the source export is on
disk) and returns a `RecoveryInfo{tier, case, ...}`. The **tier string**
(`resume` / `cleanup` / `ok`) is a contract with the desktop wrapper and does
not change; only behavior and `detail` wording are summarized here.

| Case | Detected signals | `tier` | Runtime behavior | Observable outcome |
|------|------------------|--------|------------------|--------------------|
| **A** — stale checkpoint over wiped DB | `phase_a.persist_chunks` done, no `ingest.complete`, `ingest_batches` row absent, `count_chunks == 0` | `resume` | **Self-heal & resume.** `clear_prefix("phase_a.")` then reload from sources and re-run Phase A. Provably safe — nothing was lost (chunks are gone, units not yet seen). | Round runs normally; `outcome='success'`. |
| **B** — workset row gone, chunks survived, **source on disk, units NOT yet seen** | `count_chunks > 0`, `get_ingest_batch(id)` is `None`, source dir exists, re-parse yields a non-empty workset | `resume` | **Re-run Phase A** from sources (`INSERT OR IGNORE` is idempotent), then continue chunk-dependent phases. | Round runs normally; `outcome='success'`. |
| **B′** — same as B but **units already seen** (dedup ledger marks every unit) | as B, but re-parse yields an **empty** in-memory workset while durable chunks remain | `resume`* | **Skip the round.** Re-parsing rebuilds nothing (all units filtered as seen); extracting zero chunks would be a silent no-op over surviving data. `_maybe_heal_missing_workset` raises `SkipRoundError`. | `state='done'`, `outcome='skipped'`, warning + snapshot advice. Graph untouched. |
| **B″** — workset row gone, chunks survived, **source NOT on disk** | `count_chunks > 0`, `get_ingest_batch(id)` is `None`, source dir absent | `cleanup` | **Skip the round.** Cannot re-parse (no source) and cannot rebuild from the ledger. `SkipRoundError`. | `state='done'`, `outcome='skipped'`, warning + snapshot advice. Graph untouched. |
| **C** — legacy checkpoint | `workset_schema == 0` | `cleanup` | **Skip the round.** No reconstructable workset format. `SkipRoundError` (raised early in `_load_workset` when Phase A was done under a legacy schema). | `state='done'`, `outcome='skipped'`, warning + snapshot advice. Graph untouched. |
| **D** — corrupt workset | `ingest_batches` row exists but `state != 'ready'` (and `!= 'complete'`), **or** recorded chunk-count ≠ actual | `cleanup` | **Skip the round.** Partial-write / damaged intermediate state; `SkipRoundError` from `_load_workset`. | `state='done'`, `outcome='skipped'`, warning + snapshot advice. Graph untouched. |

\* The classifier still returns tier `resume` for B′ (source is on disk); the
*emptiness* is only discovered at load time inside `_maybe_heal_missing_workset`,
which is where the skip decision is made. The tier is a coarse pre-flight hint
for the wrapper, not the final verdict.

### Not a rescue case (normal outcomes)

| Situation | Signals | Behavior |
|-----------|---------|----------|
| Healthy resume | `ingest_batches` row present, `state='ready'`, chunk-count matches | Hydrate workset, resume from first unfinished step. |
| Completed round re-opened | `ingest_batches` `state='complete'` and `ingest.complete` done | Plain **`RuntimeError`** ("workset no longer available"). Re-opening a finished round is a logic error, not a recoverable break — reported honestly, never silently treated as empty. |
| Nothing to recover | no checkpoint row, or Phase A not started, or round completed and cleaned up | `tier='ok'`, no action. |

---

## What "skip the round" does, step by step

When the pipeline raises `SkipRoundError`, `run_ingestion` catches it (it never
escapes to the server's blanket error handler) and:

1. **Logs** the skip (`logger.warning`, workset-unrecoverable).
2. **`checkpoint.reset()`** — mints a fresh `batch_id` and clears the round's
   resume steps. **Touches no graph data.** The next round starts clean and
   keeps accumulating.
3. Builds `IngestResult(0, 0, 0, 0, skipped_reason=str(exc))` →
   `outcome == "skipped"`, `warning == skipped_reason`.
4. Publishes it via `counts_callback` so the warning lands in
   `ingest_progress`, and the terminal `report("done", 1.0, "round skipped: …")`
   persists `state='done'` + warning into `ingest_runs` (surfaced by `/status`).

`SkipRoundError` subclasses `RuntimeError` on purpose: if any call path ever
misses the `except`, it degrades to the old hard-fail behavior rather than
silently swallowing the loss.

### The accepted trade-off

A skipped round's units stay marked **seen** in the dedup ledger (they were
committed atomically in Phase A, before Phase B). So their facts are **not**
re-derived automatically on the next round. Recovering that round's data
requires a **snapshot restore** — the wrapper restores a pre-round snapshot
(taken via `POST /ingest/backup`, filed under `ingestion_id`) with
`POST /ingest/restore`. kl performs no lossy logical deletion and holds no copy
of its own beyond what the wrapper explicitly snapshots.

#### Why there is no "partially seen" case

One might expect an interrupted round to leave *some* units seen and others not,
needing its own tier. It cannot: **marking units seen is atomic per round.**
Phase A's `insert_chunks_with_units` writes the chunks, the unit "seen" marks,
the `ingest_batches` workset row, **and** the `phase_a.persist_chunks` checkpoint
step in a **single SQLite transaction** (`pipeline.py` `_persist_chunks`). So a
round is **all-seen or none-seen**:

- **Died before that commit** → zero units seen, chunks absent → **Case A**
  (re-parsing sources is safe; nothing was lost).
- **Committed** → *every* unit of the round is seen at once. There is no
  per-message partial commit, hence no partial-seen tier to classify.

That also means "**seen but not yet extracted**" is the **normal** mid-round
state, not a failure: between Phase A's commit and Phase B finishing, all of the
round's units are seen while their facts are still pending. It is recoverable
because resume does **not** re-parse sources — `_load_workset` hydrates Phase B's
input directly from the durable workset (`get_ingest_batch` + surviving `chunks`
rows). A crash here with the workset row **intact** (`state='ready'`) is just a
*Healthy resume* (the non-rescue table above), precisely because re-parsing is
avoided when units are already seen.

The loss only bites when the workset row **also** vanishes (Case B′ / B″ / C /
D): the seen-but-unextracted units can no longer be rebuilt — re-parsing filters
them all out as seen, and the ledger holds seen-flags, not chunk text. That is
exactly what skip-with-warning captures. The unit of loss is therefore always
**the whole interrupted round**, never a subset of its messages — which is why a
single `skipped` outcome (plus the snapshot-restore path) is sufficient and no
finer-grained "partial" recovery tier exists.

---

## Scenario guide: what to do in each situation

Operator/wrapper-facing. Every "run ingest" below means **`POST /ingest` with the
same `source_id`** (see *What "next round" means*). Nothing here needs
`--fresh-db`; kl never suggests it.

| Scenario | Symptom | Do this | Why |
|----------|---------|---------|-----|
| **Process crashed mid-ingest** (OOM / kill -9 / power loss) | `/status` may still read `running` from before the crash; server restarted | Just **run ingest again** (same `source_id`). No stop needed. | Checkpoint + workset are durable; a matching `source_hash` resumes from the first unfinished step. Extraction cache avoids re-billing already-extracted chunks. |
| **Job wedged / hung** (no progress, want the process to let go of files) | `state='running'`, no advancement | **`POST /ingest/stop`**, then run ingest again. | Stop cancels the task (≤30 s) and releases DB/vector handles. It's reversible — the round identity and workset are untouched; the re-issued ingest resumes normally. |
| **`recovery_tier: "resume"`** before re-ingesting | recovery-info reports `resume` | **Run ingest** (same `source_id`). Optionally snapshot first with **`POST /ingest/backup`**. | Case A / Case B-with-source rebuild the workset (Phase A is idempotent) and continue. Expected outcome `success`. *Caveat:* a `resume` can still turn into a skip if the source's units are all already seen (Case B′) — the pre-round snapshot is cheap insurance. |
| **`recovery_tier: "cleanup"`** before re-ingesting | recovery-info reports `cleanup` (Cases C / D / B-source-gone) | If that round's data matters, **restore a pre-round snapshot** for this `ingestion_id` via **`POST /ingest/restore`** first; then **run ingest**. | The broken round **cannot** be rebuilt; the next ingest will auto-**skip** it (`state='done'`, `outcome='skipped'`, warning), `checkpoint.reset()`, and keep accumulating. The skipped round's facts are lost unless restored from a snapshot. |
| **`recovery_tier: "ok"`** | no anomaly | **Run ingest** normally. | Fresh load or healthy resume; nothing to rescue. |
| **You want a pre-round backup** | before any risky round | **`POST /ingest/backup`** with a `dest_dir` keyed to `ingestion_id`. (No separate stop needed — backup self-quiesces via the single-writer barrier.) | Crash-consistent copy of all stores except the rebuildable `extraction_cache.db`. Restore later with `POST /ingest/restore`. |
| **Round reported `outcome: "skipped"`** | `/status` shows `skipped` + warning | Read the `warning`; restore a snapshot only if that round's data is needed. Otherwise **nothing to do** — the next round already accumulates cleanly. | Skip is the designed safe outcome, not an error. The graph was preserved. |
| **Round reported `outcome: "partial"`** | `extraction_failed > 0`, `failures_url` set | Fetch `GET /ingest/{run_id}/failures`; re-run ingest to retry failed items. | Partial = per-item extraction failures (distinct from a skipped round). Cache keeps successful items from re-billing. |
| **Confidential / no-permission conversation** | server-side source refused | **Leave it out of scope; do not retry with different creds/params.** Record as unreadable, not `0`. | Access refusal is a boundary, not a recoverable failure (AGENTS.md §5). |

**Never** reach for `--fresh-db` as a recovery step. It is a real, deliberate
manual full-database rebuild flag; as *recovery advice* it would destroy the
long-lived accumulated graph. Recovery advice is always "skip this round; restore
a snapshot if that round's data is needed."

---

## Orphan / dangling rows

`PRAGMA foreign_keys` is never enabled, so orphaned rows (e.g. workset children
whose parent batch was deleted) never raise — they only accumulate. Current
policy is **tolerate, don't warn, don't delete**: a skip round leaves the
imperfect DB state in place rather than emitting loud warnings. A dedicated
orphan-sweep (`kl db cleanup`) is deferred to a separate change and is **not**
part of the recovery path today.

---

## Observing a rescue

See **API → Observing outcomes** above for `GET /status` and the failure
manifest. Everything surfaced there is also persisted durably in the
`ingest_runs` table (`state`, `detail`, `warning`, `outcome` per `run_id`), so a
skip is observable even after a restart — never a silent "0 rows, all good".

---

## Related docs

- [`ingestion-recovery-design.md`](./ingestion-recovery-design.md) — full
  rationale, durable-state fix, round-start identity contract, server surface.
- [`checkpoint-design.md`](./checkpoint-design.md) — checkpoint step semantics.
- [`ingestion-artifact-dependencies.md`](./ingestion-artifact-dependencies.md) —
  workset lifecycle.
- [`ingest-api.md`](./ingest-api.md) — server endpoints and status fields.
