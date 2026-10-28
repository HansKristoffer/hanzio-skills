---
name: prod-data
description: Change data in production safely with a one-off script (a backfill, a merge or deduplication, a format fix, a bulk correction, credits or grants to users, moving data to another store): written and reviewed in the repo, dry run by default on a read-only connection, counts and samples read before any write, a way back, small batches and a check afterwards. Use when asked to backfill, fix, clean up, merge, migrate or bulk-edit data in production or staging, to run a script or query against the production database, or to "do it in prod". Built for TypeScript monorepos (Bun or Node, Prisma, Zod, oRPC, hanzio, Vue or React/Expo); reads the repository's own rules first and lets them win.
---

# Change production data

A data change in production has no CI and often no undo. The method is the same every time: the change lives in a script in the repository, the script proves what it will do on a connection that cannot write, a person sees the numbers, and only then does it write, a little at a time, keeping a record that undoes it.

Schema changes are migrations, not scripts: follow the repository's migration convention, and for lock-safe Postgres migrations call the Skill tool with `postgres-tuning`.

## Learn the repository first

Read the root and nearest `AGENTS.md` / `CLAUDE.md`. They override this skill. Find:

- where one-off scripts live (`scripts/`, `apps/backend/scripts/`) and how they run (`bunx buncargo run <name>`, `bun <file>`);
- how production secrets are reached: the secret store (Infisical, Railway variables), the repository's secret loader and its environment switch (for example `SECRETS_ENV=prod`);
- whether there is a staging environment with a copy of production's shape;
- the database's backups: point-in-time recovery or snapshots, and how far back.

## 1. Write the script

In the repository, on a branch, reviewed like any code. The script:

- **dry-runs by default** and writes only with `--apply`; `--limit N` caps how many records it touches;
- in a dry run, first tries a write (`create temp table _read_only_probe (a int)`) through its own database client and stops when it succeeds, so a client that ignored the read-only setting cannot pass;
- prints counts per kind of change, and a sample of before → after values with record ids, keeping personal data to what the reader needs;
- is idempotent: a second `--apply` finds nothing left to do;
- writes through the app's own update functions when their side effects must happen (a sync to HubSpot, events, an audit log), and with direct SQL only when they must not. Say which, and why;
- writes in batches, one transaction each, resumable from the last id it finished;
- with `--apply`, appends every changed record's id and old values to an undo file before writing it.

Test it locally against seeded data that has the problem. A local dry run that finds nothing proves only that the script writes nothing; the production dry run is the real check.

Ship the script with the `land-pr` skill. The runs below use the merged code, the code production runs.

## 2. Get the production URL without showing it

The URL is a secret. It goes to a private file, never into the conversation, a command line, a log or a commit:

```bash
umask 077
url_file=$(mktemp)
infisical secrets get DATABASE_URL --env=prod --plain > "$url_file"   # or the repository's own secret loader
bash "$SKILL_DIR/scripts/read-only-url.sh" "$url_file"
```

`SKILL_DIR` is this skill's directory. [scripts/read-only-url.sh](scripts/read-only-url.sh) writes `"$url_file.ro"` with `default_transaction_read_only=on` added, prints only the host, and proves with `psql` that Postgres refuses a write on it (exit 0). Exit 1 means the connection can write: stop. Pass the URL to the script by reading the file into its environment (`DATABASE_URL="$(cat "$url_file.ro")" bun <script>`), and delete both files when you are done.

When the URL cannot be reached, ask the user to run the dry run and paste the output, and give them the exact command.

## 3. Dry-run on production

Run the script without `--apply` on the read-only URL. Read the output yourself before reporting: the counts against what you expected, and every sample. A sample that looks wrong is a bug in the script, found before it wrote anything: a format rule that does not fit some rows, a match that joins records that should stay apart. Fix it in a follow-up PR and dry-run again on the merged code.

Run it on staging first when staging has production's shape.

## 4. Know the way back

Before any write, name how each part is undone:

- the undo file the script writes, and the command that replays it;
- the database's point-in-time recovery or a fresh snapshot: confirm it exists and how far back it reaches;
- what cannot be undone: data sent to another system (a HubSpot merge, an email, a payment), records merged or deleted without an undo file. Say so plainly.

## 5. Ask before the writes

Ask once, with the dry run's counts, two or three samples, what cannot be undone, and the way back. An explicit request for this exact change ("add 1000 coins to every user in prod") is the yes when the dry run shows exactly that and every part can be undone. Ask anyway when the dry run shows more or other than was asked, or when any part cannot be undone. A "full send" covers code, never production data.

## 6. Write in small steps

1. `--apply --limit 10` (or the smallest batch that means something). Read those records back and check them in the app.
2. The rest, in batches. Watch the app's error rate and logs while it runs, and stop at the first surprise.

The write needs a writable URL: the one in `"$url_file"`, still never printed.

## 7. Check and clean up

- Dry-run again: it finds nothing left to do.
- Re-run any audit the change was meant to improve, and compare its numbers with the first run.
- Delete the URL files, keep the undo file somewhere private, and say where.
- Report: what changed, in counts, the before and after numbers, what cannot be undone, and where the undo file is.
