# keeper-agent (milestone 2)

an agent that turns evidenced demand into monetized onchain infrastructure. it refuses to build without evidence, refuses to publish outside its risk policy, heals its own drafting errors against KeeperHub's responses, proves every workflow with a real transaction before listing it, and earns when a genuinely separate identity pays via x402. every claim is anchored to a KeeperHub execution id or tx hash in a provenance certificate.

## the loop

demand ledger (Supabase) -> evidence gate (3+ events, no invention) -> Claude drafts parameters only (fixed node template, no free-form graphs) -> deterministic risk policy in code (testnet only, capped amounts, auto-reject approvals/writes) -> create + validate on KeeperHub, self-heal max 2 attempts -> real self-test execution (tx #1) -> publish at $0.05+ (KeeperHub's own anti-self-dealing floor) -> second identity pays via x402 (tx #2) -> provenance certificate links all of it.

## new env vars (add in Railway on top of milestone 1)

- `ANTHROPIC_API_KEY` = Claude api key (console.anthropic.com), used for drafting + healing
- `BUYER_PRIVATE_KEY` = private key of a SEPARATE wallet used only as the buyer. fund it with testnet USDC only. never reuse the creator identity.
- `WORKFLOW_PRICE_USD` = 0.05 (default)
- `DEMAND_THRESHOLD` = 3 (default)

## setup delta from milestone 1

1. paste `schema_v2.sql` into the Supabase SQL editor and run it
2. add the four new env vars in Railway
3. push the new files: `index.js`, `pipeline.js`, `buyer.js`, `package.json`

## the run order (all urls, replace YOURAPP and SECRET)

1. `/health` — confirm the two new keys show "set"
2. `/ledger/seed?secret=SECRET` — seed 3 labeled demo demand events (or log real ones via `/ledger/log?secret=..&raw=..&need=checked-transfer&reason=..`)
3. `/ledger?secret=SECRET` — see the evidence, grouped
4. `/run/factory?secret=SECRET` — THE run. drafts, risk-checks, heals, self-tests with a real tx, publishes. returns the provenance id, the tx link, and the listing slug
5. `/run/buyer?secret=SECRET&slug=THE_SLUG` — the second identity pays and calls it
6. `/provenance/PROV_ID?secret=SECRET` — the birth certificate: why it exists, how it was built, proof it works, proof it earns
7. `/` — glass-box live terminal (paste the secret in the input, it polls runs every 3s)

## honesty notes

- seeded demand events are labeled `source: 'seeded'` and shown as such. real logged ones are `'live'`.
- the factory refuses to run below the evidence threshold (HTTP 412), refuses risk-policy violations (HTTP 403), and refuses to publish a workflow whose self-test did not succeed.
- two calls are flagged least-verified against docs and log their raw responses for a one-round fix if the field names differ: `POST /api/workflows/{id}/validate` and `POST /api/workflows/{id}/list`. if either 4xxs, paste the trace back into chat.
- the buyer probes the 402 challenge first and returns it raw, so if the x402 protocol version differs, the fix is visible instead of guessed.

## debugging

every endpoint returns a `trace` array with raw KeeperHub responses, and every run is stored in Supabase. copy the json back into the Claude chat. that is the loop.
