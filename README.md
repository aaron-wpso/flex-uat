# FLEX Phase 1 UAT - local check-off app

Tool for running the Phase 1 UAT session. 538 test cases across 20 modules,
ticked live with a remark against each individual case, a signature block for
sign-off, and as many test rounds as the project needs.

It runs two ways from the same `docs/index.html`:

| | Storage | Two reviewers at once |
|---|---|---|
| `node server.mjs` | SQLite (`uat.db`) | Yes, over the LAN |
| Static / GitHub Pages | The browser's `localStorage` | No - per browser |

Which one is in play is decided at load: if `/api/state` answers, it uses the
server; if not, it keeps results in the browser. The footer says which.

## Run it

Double-click `start.cmd`, or:

    node server.mjs

Then open http://localhost:4180

Requires Node 22.5 or newer (uses the built-in `node:sqlite`). No `npm install`,
no dependencies.

## Two people at once

The server also listens on the local network. The console prints a
`http://192.168.x.x:4180` address - open that on the second reviewer's laptop
and both boards stay in step (polled every 3 seconds).

## Test rounds

The 538 test cases are fixed. What changes between a first pass and a retest
after bugfixes is what was *observed*, so results are recorded per round.

Pick the round in the left rail. **+** starts the next one, **x** discards the
one you are on (with a warning if anything is recorded in it).

A new round starts completely empty - nothing is copied forward, so a pass in
Round 2 always means someone actually re-witnessed it. Round 1 is never
touched by what you record later.

Each round carries its **own session details and signatures**, because a retest
runs against a different build and gets signed on a different day. Switching
rounds switches those too, and Export PDF documents the round you are on.

## Where the results live

Running under `server.mjs`: `uat.db`, a SQLite file next to it. Back it up or
copy it to keep the session record. Tables: `results`, `remarks`, `meta`.
`results` and `remarks` are keyed `(round, module, case_id)` - one remark per
test case, per round. Per-round session fields live in `meta` as `R2.backend`,
`R2.sig_client` and so on; the round list is `__rounds`.

A database from before rounds existed is migrated on first start: everything in
it becomes Round 1. It says so in the console when it does.

Served statically: all rounds in that browser's `localStorage` under `flex-uat-v1`. It is
per browser and per device - clearing site data clears the run. For a session
you must not lose, run the server.

Inspect it with any SQLite browser, or:

    node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('uat.db');console.table(d.prepare('SELECT value,COUNT(*) n FROM results GROUP BY value').all())"

## Export the PDF for the client

Click **Export PDF**. It lays out all 538 cases from M1 through A12 as one
document - cover sheet with the session details and per-module totals, then
every module with its ticks stamped and remarks included - and opens the browser
print dialog. Choose **Save as PDF**.

The cover names the round. Remarks print underneath the case they belong to,
and only where one was written. The attached signatures render on a final
**Sign-off** page. Export once per round to hand over both records.

Set the print destination to A4 and leave "Background graphics" on so the
result marks and module tiles print.

## Signatures

On **S1 Session setup**, each signer has an *Attach image* slot - a photo or
scan of a signature. They belong to the round you are on. The image is downscaled to 720px wide and stored inline
with the rest of the session data, so it travels with the results and prints
into the PDF. Nothing is uploaded anywhere.

## Starting over

    curl -X POST http://localhost:4180/api/reset

or just delete `uat.db` and restart.

## No app? Use the paper version

`../files/FLEX_Phase1_UAT_TestCases.pdf` is the same 538 cases as a printable
checklist with `[ ] P  [ ] F  [ ] N/D` boxes and remarks space. Rebuild it with:

    cd ../files
    npx md-to-pdf --config-file uat-pdf.config.js FLEX_Phase1_UAT_TestCases.md
