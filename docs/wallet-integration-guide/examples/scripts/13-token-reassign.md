# 13 – Cross-Synchronizer Token Reassignment (DvP Trade)

## Topology

```
┌─────────────────────────────────────────────────────────┐
│                   PARTICIPANT (app-user)                 │
│                                                         │
│   Parties: Alice, Bob, Venue                            │
│   (all registered on both synchronizers)                │
│                                                         │
├────────────────────────┬────────────────────────────────┤
│                        │                                │
│   ┌────────────────────▼──────────────────────┐         │
│   │          PRIVATE SYNCHRONIZER             │         │
│   │                                           │         │
│   │  DARs vetted:                             │         │
│   │    • token-composition (Token,            │         │
│   │      TokenAllocation)                     │         │
│   │    • token-private (TokenRules)           │         │
│   │    • splice-api-token-* interfaces        │         │
│   │                                           │         │
│   │  Contracts:                               │         │
│   │    TokenRules  (Venue admin)              │         │
│   │    Token       (Bob's holdings)           │         │
│   │    TokenAllocation (Bob → trade)          │         │
│   └───────────────────────────────────────────┘         │
│                                                         │
│   ┌───────────────────────────────────────────┐         │
│   │          GLOBAL SYNCHRONIZER              │         │
│   │                                           │         │
│   │  DARs vetted:                             │         │
│   │    • token-composition (Token,            │         │
│   │      TokenAllocation)                     │         │
│   │    • splice-token-test-trading-app        │         │
│   │      (OTCTradeProposal, OTCTrade)         │         │
│   │    • splice-amulet                        │         │
│   │    • splice-api-token-* interfaces        │         │
│   │                                           │         │
│   │  Contracts:                               │         │
│   │    OTCTradeProposal / OTCTrade (Venue)    │         │
│   │    Amulet holdings (Alice)                │         │
│   │    AmuletAllocation (Alice → trade)       │         │
│   └───────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────┘
```

## Business Goal

Minimize global synchronizer usage (and cost) by keeping custom token
operations on a private synchronizer. Only move contracts to the global
synchronizer when settlement requires co-location of both legs.

## Contract Flow

```
PRIVATE SYNC                          GLOBAL SYNC

TokenRules ──mint──► Token (Bob)
                                      OTCTradeProposal (Alice creates)
                                        ├─ Bob accepts
                                        └─ Venue initiates settlement
                                              │
                                              ▼
                                      OTCTrade (settlement contract)
                                              │
Token (Bob) ──allocate──►                     │
  TokenAllocation (Bob)                       │
                │                             │
                │  ──reassign──►  TokenAllocation (Bob)
                                              │
                                      AmuletAllocation (Alice)
                                              │
                                      OTCTrade_Settle
                                        ├─ Token → Alice
                                        └─ Amulet → Bob
```

## Step-by-Step

### 1. SDK Initialization

```
SDK.create(auth, ledgerClientUrl)
sdk.token(...)
sdk.amulet(...)
sdk.asset(...)
```

### 2. Discover Synchronizers

```
sdk.ledger.state.connectedSynchronizers({})
→ globalSyncId, privateSyncId
```

### 3. Upload & Vet DARs

| DAR                             | Synchronizer(s)  | SDK Call                                            |
| ------------------------------- | ---------------- | --------------------------------------------------- |
| `splice-token-test-trading-app` | global           | `sdk.ledger.dar.upload(bytes, name, globalSyncId)`  |
| `token-composition`             | global + private | `sdk.ledger.dar.upload(...)` × 2                    |
| `token-private`                 | private          | `sdk.ledger.dar.upload(bytes, name, privateSyncId)` |

### 4. Allocate Parties (both synchronizers)

For each party (Alice, Bob, Venue):

```
sdk.party.external.create(pubKey, { synchronizerId: globalSyncId }).sign(privKey).execute()
sdk.party.external.create(pubKey, { synchronizerId: privateSyncId }).sign(privKey).execute({ forceAllocate: true })
```

### 5. Create TokenRules Factory (private sync)

```
sdk.ledger.prepare({ commands: CreateCommand(TokenRules), synchronizerId: privateSyncId })
  .sign(venue).execute()
```

### 6. Mint Tokens for Bob (private sync)

```
sdk.ledger.acs.read({ templateIds: [TokenRules] })  → tokenRulesCid
sdk.ledger.prepare({ commands: ExerciseCommand(TokenRules_Mint), synchronizerId: privateSyncId })
  .sign(venue).execute()
```

### 7. Tap Amulet for Alice (global sync)

```
amulet.tap(alice, amount)  → [cmd, disclosed]
sdk.ledger.prepare({ commands: cmd, disclosedContracts: disclosed })
  .sign(alice).execute()
```

### 8. Create Trade Proposal (global sync)

```
sdk.ledger.prepare({ commands: CreateCommand(OTCTradeProposal), synchronizerId: globalSyncId })
  .sign(alice).execute()
```

Two transfer legs:

- leg0: Bob → Alice, 100 PrivateToken
- leg1: Alice → Bob, 20 Amulet

### 9. Bob Approves Proposal (global sync)

```
sdk.ledger.acs.read({ templateIds: [OTCTradeProposal] })  → proposalCid
sdk.ledger.prepare({ commands: ExerciseCommand(OTCTradeProposal_Accept) })
  .sign(bob).execute()
```

### 10. Venue Initiates Settlement (global sync)

```
sdk.ledger.prepare({ commands: ExerciseCommand(OTCTradeProposal_InitiateSettlement) })
  .sign(venue).execute()
```

Creates an `OTCTrade` contract with allocation requests.

### 11. Bob Allocates PrivateToken (private sync)

```
token.allocation.request.pending(bob)  → allocation request
sdk.ledger.acs.read({ templateIds: [Token] })  → bobTokenCid
sdk.ledger.prepare({
    commands: ExerciseCommand(AllocationFactory_Allocate on TokenRules),
    disclosedContracts: [tokenRulesDisclosed],
    synchronizerId: privateSyncId
}).sign(bob).execute()
```

Creates `TokenAllocation` on the private synchronizer.

Note: uses the **interface ID** as `templateId` for the exercise command.

### 12. Alice Allocates Amulet (global sync)

```
token.allocation.request.pending(alice)  → allocation request
token.allocation.instruction.create({ spec, asset })  → [cmd, disclosed]
sdk.ledger.prepare({ commands: cmd, disclosedContracts: disclosed, synchronizerId: globalSyncId })
  .sign(alice).execute()
```

Creates `AmuletAllocation` on the global synchronizer.

### 13. Reassign TokenAllocation (private → global)

Two-step process:

```
sdk.ledger.unassign({ submitter: bob, contractId, source: privateSyncId, target: globalSyncId })
→ reassignmentId

sdk.ledger.assign({ submitter: bob, reassignmentId, source: privateSyncId, target: globalSyncId })
```

Bob's `TokenAllocation` now lives on the global synchronizer, co-located with Alice's `AmuletAllocation`.

### 14. Venue Settles Trade (global sync)

```
token.allocation.pending(venue)  → allocations
token.allocation.context.execute(cid, registryUrl)  → context + disclosed

sdk.ledger.prepare({
    commands: ExerciseCommand(OTCTrade_Settle, { allocationsWithContext }),
    disclosedContracts: [...]
}).sign(venue).execute()
```

Settlement executes `Allocation_ExecuteTransfer` on each allocation:

- Bob's TokenAllocation → creates Token for Alice
- Alice's AmuletAllocation → transfers Amulet to Bob

### 15. Verify Final State

```
sdk.ledger.acs.read({ templateIds: [Token], parties: [alice] })  → Alice has PrivateToken
token.utxos.list({ partyId: bob })   → Bob has Amulet
token.utxos.list({ partyId: alice }) → Alice has remaining Amulet
```

## Prerequisites

```bash
yarn build:all
yarn start:localnet    # needs multi-sync profile
cd docs/wallet-integration-guide/examples
yarn run-13
```
