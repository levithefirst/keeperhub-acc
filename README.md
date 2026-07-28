# keeper-agent

An agent that finds a gap, builds a KeeperHub workflow to fill it, proves the
workflow works with a real onchain transaction, publishes it to the marketplace
at a price, and then gets paid for it by a different wallet.

Producer and consumer, one runtime, all settled onchain.

Built for the KeeperHub Agents Onchain Hackathon.

---

## The claim, and the proof

Every hash below is real and independently verifiable. Nothing is mocked.

### Autonomous run

One call to `/run/factory` produced a live, priced, callable marketplace listing.
A separate wallet then paid it.

| Step | Network | Transaction |
|---|---|---|
| Self-test execution | Sepolia | [`0x01dfb68f…766cc8`](https://sepolia.etherscan.io/tx/0x01dfb68fbbf13697a261247a3120ca91b18964de8908da07ef43a75042766cc8) |
| **x402 payment settlement** | **Base mainnet** | [`0xe8b92beb…0a0852`](https://basescan.org/tx/0xe8b92beb62c3fa6757aaea9ff9977642a3de08bc140b5bae1cf6c81d050a0852) |
| The execution that payment bought | Sepolia | [`0xf12fa4a1…318c5a`](https://sepolia.etherscan.io/tx/0xf12fa4a1c9a0676ba300a1bd0ec6f140703c47249b25d8ee417f1825a1318c5a) |

Workflow `gxjrcjgs8gyq6sbud5jp1`, listed as `checked-transfer-2bet` at $0.05 USDC per call.

A second autonomous run, `checked-transfer-g63s` (workflow `q681buludh0q3mmu72ags`),
self-tested at [`0x3c80e6b2…86de48`](https://sepolia.etherscan.io/tx/0x3c80e6b29284444daf061eccf13d12c251d09407bd0416c112fc2c1d8d86de48)
and is live and charging now.

### The two identities

| Role | Address |
|---|---|
| Creator (receives payment) | `0xc68f0E22Dc6eD7e883873B36f23DdBBC1b3968Ac` |
| Buyer (sends payment) | `0x0Aab4edD80E3723D10A636EDCcc7A5b66275b1E0` |
| x402 facilitator (submits tx, pays gas) | `0xB87E1A2cc2B4643F2892768e80e41167F17C5860` |

Read the BaseScan page for the settlement: the transaction is submitted by the
facilitator, the USDC moves buyer → creator, and the buyer pays zero gas. That
is EIP-3009 `TransferWithAuthorization` doing what it is supposed to do.

---

## Verify it yourself

The service is live. Replace `$RUN_SECRET` with the secret shared in the
submission notes.
