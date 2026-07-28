# keeper-agent

An agent that finds a gap, builds a KeeperHub workflow to fill it, proves the workflow works with a real onchain transaction, publishes it to the marketplace at a price, and then gets paid for it by a different wallet.

Producer and consumer, one runtime, all settled onchain.

Built for the KeeperHub Agents Onchain Hackathon.

---

## The claim, and the proof

Every hash below is real and independently verifiable. Nothing is mocked.

### Autonomous run

One call to `/run/factory` produced a live, priced, callable marketplace listing. A separate wallet then paid it.

| Step | Network | Transaction |
|---|---|---|
| Self-test execution | Sepolia | [`0x01dfb68f…766cc8`](https://sepolia.etherscan.io/tx/0x01dfb68fbbf13697a261247a3120ca91b18964de8908da07ef43a75042766cc8) |
| **x402 payment settlement** | **Base mainnet** | [`0xe8b92beb…0a0852`](https://basescan.org/tx/0xe8b92beb62c3fa6757aaea9ff9977642a3de08bc140b5bae1cf6c81d050a0852) |
| The execution that payment bought | Sepolia | [`0xf12fa4a1…318c5a`](https://sepolia.etherscan.io/tx/0xf12fa4a1c9a0676ba300a1bd0ec6f140703c47249b25d8ee417f1825a1318c5a) |

Workflow `gxjrcjgs8gyq6sbud5jp1`, listed as `checked-transfer-2bet` at $0.05 USDC per call.

A second autonomous run, `checked-transfer-g63s` (workflow `q681buludh0q3mmu72ags`), self-tested at [`0x3c80e6b2…86de48`](https://sepolia.etherscan.io/tx/0x3c80e6b29284444daf061eccf13d12c251d09407bd0416c112fc2c1d8d86de48) and is live and charging now.

### The two identities

| Role | Address |
|---|---|
| Creator (receives payment) | `0xc68f0E22Dc6eD7e883873B36f23DdBBC1b3968Ac` |
| Buyer (sends payment) | `0x0Aab4edD80E3723D10A636EDCcc7A5b66275b1E0` |
| x402 facilitator (submits tx, pays gas) | `0xB87E1A2cc2B4643F2892768e80e41167F17C5860` |

Read the BaseScan page for the settlement: the transaction is submitted by the facilitator, the USDC moves buyer to creator, and the buyer pays zero gas. That is EIP-3009 `TransferWithAuthorization` doing what it is supposed to do.

---

## Verify it yourself

The service is live. Replace `$RUN_SECRET` with the secret shared in the submission notes.

Base URL: `https://keeperhub-acc-production.up.railway.app`

**Confirm the listing is real and charging.** No auth needed, this is public:

`POST https://app.keeperhub.com/api/mcp/workflows/checked-transfer-g63s/call`

Returns `402` with an x402 v2 `PAYMENT-REQUIRED` header: `exact` scheme, `eip155:8453`, Base USDC, `amount: "50000"` (0.05 USDC), `payTo` the creator wallet. It also advertises `extensions.bazaar.discoverable: true`.

**Watch the whole loop run:**

- `/ledger/seed?secret=$RUN_SECRET` — log demand evidence
- `/run/factory?secret=$RUN_SECRET` — build, prove, publish (~60s)
- `/x402/pay?secret=$RUN_SECRET&target=<slug>` — spends $0.05 of real USDC

`/run/factory` returns `result: "PUBLISHED AND CHARGING"` plus a full step-by-step trace, the self-test tx, and a `callable` block confirming the new listing answers a 402.

**Other endpoints**

| Route | What it does |
|---|---|
| `/health` | env check, no secret required |
| `/ledger` | demand evidence, grouped, with the threshold |
| `/provenance/:id` | the certificate for one build |
| `/runs` | last 20 runs |
| `/survey` | read-only census of the public marketplace |
| `/x402/probe?target=<slug>` | capture any 402 challenge, free, no payment |
| `/mcp/tools` | the live KeeperHub MCP tool list |
| `/mcp/call?tool=&args=` | call any of the 35 MCP tools from a browser |
| `/discover` | schema registry, openapi surface, workflow states |
| `/` | live dashboard |

---

## How it works

demand evidence -> Claude drafts PARAMETERS ONLY -> deterministic risk policy (can refuse) -> fixed node template -> create and execute (real onchain tx) -> execution integrity check -> publish: enable, price, list, verify -> separate wallet pays via x402 -> provenance certificate

**The evidence gate.** The agent will not build without logged evidence of demand. Below the threshold it returns `412 NO BUILD`. It does not invent a reason to exist.

**Claude drafts parameters, never the graph.** The node graph is a hardcoded template in `buildNodes()`. The LLM fills in five values: name, title, description, threshold, amount. This is deliberate. An LLM-generated graph reintroduces exactly the schema errors that cost the most time to debug.

**The risk policy is pure code.** `riskCheck()` contains no LLM call. Testnet allowlist, transfer cap of 0.001 ETH, naming policy. It returns `403` and refuses to publish. A policy an LLM can be argued out of is not a policy.

**Failures are classified before they are healed.** A TEMPLATE error means the graph shape is wrong; re-drafting parameters cannot fix that, so the agent aborts with `KH-TEMPLATE-MISMATCH` instead of burning retries on the wrong layer. Only PARAMETER errors heal, capped at two attempts, and every healed draft must re-pass the risk policy.

**The integrity check exists because KeeperHub lied to us once.** A malformed Condition node was accepted at create time, silently pruned from the execution graph at runtime, and the execution still reported `"success"` with 2 of 4 nodes run. So "success" is not accepted as proof. After every self-test the agent diffs the graph it built against the nodes that actually executed. Any missing node, or a transfer that did not fire, blocks publication.

**Publication is verified against the public listing, not the write response.** Four separate flags can each silently kill a listing while every write returns `200`. The agent sets them in the correct order and then reads the listing back through the public, unauthenticated `get_workflow_listing` before claiming success.

---

## KeeperHub surfaces used

- **REST API** — workflow create, execute, execution status and logs, direct execution
- **MCP server** (`/mcp`, JSON-RPC 2.0 over HTTP) — `update_workflow`, `unlist_workflow`, `update_workflow_listing`, `list_workflow`, `get_workflow_listing`, `get_workflow`, `get_execution`. The publish sequence runs entirely over MCP.
- **x402** — v2, `exact` scheme, EIP-3009 on Base mainnet USDC, paid from a raw key server-side with `@x402/fetch` and `viem`. MPP on Tempo is offered in parallel on the same challenge; this agent takes the x402 rail.
- **Workflow builder primitives** — Manual trigger, `web3/check-balance`, Condition node, `web3/transfer-funds`, branch edges via `sourceHandle`
- **Audit trail** — `executionTrace`, per-node logs, `billable`, `triggerSource`, `executedWorkflowHash`
- **Marketplace** — listing, pricing, the $0.05 quota-exemption floor
- **ERC-8004** — KeeperHub auto-registers listed workflows on the ReputationRegistry (agent `31875`)

One detail worth reading in the audit trail: the internal self-test logs `billable: true, triggerSource: "manual"`, while the paid marketplace call logs `billable: false, triggerSource: "mcp"`. Same workflow, same `executedWorkflowHash`, different economics, and KeeperHub records the difference without being asked.

---

## Honest disclosures

Written here rather than buried, because a judge will find them anyway.

**Seeded demand events are labeled `source: 'seeded'`** in the database and in every API response. They are demo evidence, not real user traffic. The schema distinguishes `live` from `seeded` and the ledger reports both counts.

**Two chains by necessity.** Workflow execution runs on Sepolia, per the risk policy. x402 payment settles on Base mainnet, because KeeperHub's payment rails are Base 8453 and Tempo 4217/42431 and there is no testnet payment path. The payment leg executes no workflow node. It moves $0.05.

**The buyer wallet is funded by the same human who owns the creator wallet.** The two addresses are cryptographically distinct and the separation is visible onchain, but this is not an arms-length third-party purchase. It demonstrates the payment rail end to end; it does not demonstrate product-market fit.

**The buyer sends the org bearer token for auth while paying from a separate wallet.** The payment identity is genuinely separate and provable. The API credential is not.

---

## Findings: eleven things that cost time

Submitted separately for the Best Onboarding UX Improvement bounty, with timestamps, `cf-ray` IDs, and proposed fixes. Summarised here because they are also the reliability story.

1. `create_workflow` creates workflows **disabled by default**. A listed but disabled workflow returns `503 "the workflow owner has disabled this workflow"` on every marketplace call.
2. `list_workflow` accepts **no price field**. A listing with no price returns `200` and executes **for free** instead of issuing a 402.
3. Price lives on `update_workflow_listing` as `priceUsdcPerCall`.
4. `priceUsdcPerCall` must be a **string**. Passing `0.05` fails validation.
5. Price **cannot be changed while listed**. The sequence is unlist, price, list.
6. Condition nodes are `type: "action"` with `actionType: "Condition"` and a single JS expression string. A structured `{logicalOperator, conditions:[]}` object is **accepted at create time and silently pruned at runtime**, while the execution still reports `"success"`.
7. The transfer recipient field is `recipientAddress`, not `to`.
8. `create_workflow` requires `nodes` and `edges` in the same call. Create-then-patch is rejected.
9. Executions are signed by the **organisation's** Turnkey wallet, not a personal wallet. Funding the wrong one yields `"Insufficient ETH balance. Have: 0.0"`.
10. `GET /api/workflows/{id}` can 404 while the workflow is live in the public catalog. `get_workflow_listing` by slug is the reliable read, and needs no auth.
11. `POST /api/workflows/{id}/validate` returns **405**, not 404. Code that only treats 404 as "endpoint absent" will misread this as a real failure.

Also: the docs reference a public `mcp-test` reference workflow. It returns 404.

---

## Stack and layout

Node 22, Express, deployed on Railway. Supabase for state. KeeperHub REST and MCP for execution. Claude API (`claude-sonnet-4-6`, `temperature: 0`) for parameter drafting only. `@x402/fetch` v2, `@x402/evm`, and `viem` for payment.

| File | Contents |
|---|---|
| `index.js` | express app, all routes |
| `pipeline.js` | KeeperHub-facing logic, risk policy, node template, publish |
| `buyer.js` | x402 client: probe, sweep, paid call |
| `mcp.js` | JSON-RPC client for the KeeperHub MCP server |
| `survey.js` | read-only census of the public marketplace |
| `schema_v2.sql` | runs, demand_events, provenance |

**Environment**

| Variable | Notes |
|---|---|
| `KEEPERHUB_API_KEY` | kh_ organisation key |
| `SUPABASE_URL` | no trailing path |
| `SUPABASE_SERVICE_ROLE_KEY` | |
| `RUN_SECRET` | gates every route except `/health` and `/` |
| `TEST_ADDRESS` | wallet whose balance is checked |
| `RECEIVER_ADDRESS` | transfer destination |
| `TEST_NETWORK` | 11155111 |
| `ANTHROPIC_API_KEY` | |
| `BUYER_PRIVATE_KEY` | separate buyer identity, never the creator wallet |
| `WORKFLOW_PRICE_USD` | 0.05 |
| `DEMAND_THRESHOLD` | 3 |

**Setup:** run `schema_v2.sql` in the Supabase SQL editor, set the variables above, deploy. `/health` reports which are missing.

---

## Constraints

Built solo on a Dell i3 Chromebook with no terminal, no local development environment, and no IDE. Every file was written into GitHub's web editor, deployed by Railway, and debugged by opening a URL in Chrome and reading the JSON.

That constraint shaped the architecture rather than fighting it. Every action is a URL. Every raw KeeperHub response is stored and returned in full. `/mcp/call` turns a browser tab into an MCP client with access to all 35 tools, and `/debug/kh-proxy` does the same for REST. Several of the findings above were discovered that way, without a single deploy.
