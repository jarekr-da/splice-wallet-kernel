// Copyright (c) 2025-2026 Digital Asset (Switzerland) GmbH and/or its affiliates. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Cross-synchronizer token reassignment scenario
//
// Demonstrates a DvP trade where:
// - Bob allocates a custom PrivateToken on a private (app) synchronizer
// - Alice allocates Amulet on the global synchronizer
// - Bob's TokenAllocation is reassigned from private → global synchronizer
// - A Trading App settles the trade on the global synchronizer
//
// This minimizes global synchronizer usage (and cost) by keeping token
// operations on the private synchronizer until settlement requires co-location.

import pino from 'pino'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import { localNetStaticConfig, SDK } from '@canton-network/wallet-sdk'
import { KeyPair } from '@canton-network/core-signing-lib'
import { GenerateTransactionResponse } from '@canton-network/core-ledger-client'
import {
    TOKEN_NAMESPACE_CONFIG,
    TOKEN_PROVIDER_CONFIG_DEFAULT,
    AMULET_NAMESPACE_CONFIG,
    ASSET_CONFIG,
    getActiveContractCid,
} from './utils/index.js'

const logger = pino({ name: 'v1-13-reassign', level: 'info' })

type PartyInfo = Omit<GenerateTransactionResponse, 'topologyTransactions'> & {
    topologyTransactions?: string[] | undefined
    keyPair: KeyPair
}

// ---------------------------------------------------------------------------
// 1. SDK initialization
// ---------------------------------------------------------------------------

const sdk = await SDK.create({
    auth: TOKEN_PROVIDER_CONFIG_DEFAULT,
    ledgerClientUrl: localNetStaticConfig.LOCALNET_APP_USER_LEDGER_URL,
})

const token = await sdk.token(TOKEN_NAMESPACE_CONFIG)
const amulet = await sdk.amulet(AMULET_NAMESPACE_CONFIG)
const asset = await sdk.asset(ASSET_CONFIG)

// ---------------------------------------------------------------------------
// 2. Discover synchronizers – require at least 2 (private + global)
// ---------------------------------------------------------------------------

const connectedSyncResponse = await sdk.ledger.state.connectedSynchronizers({})
if (
    !connectedSyncResponse.connectedSynchronizers ||
    connectedSyncResponse.connectedSynchronizers.length < 2
) {
    throw new Error(
        'At least 2 connected synchronizers are required for this scenario'
    )
}

const synchronizers = connectedSyncResponse.connectedSynchronizers
const globalSyncId = synchronizers[0].synchronizerId // first is global
const privateSyncId = synchronizers[1].synchronizerId // second is app/private

logger.info(`Global synchronizer:  ${globalSyncId}`)
logger.info(`Private synchronizer: ${privateSyncId}`)

// ---------------------------------------------------------------------------
// 3. Upload DARs
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url))

// trading-app DAR (for OTCTradeProposal / OTCTrade) – vetted on global only
const tradingDarPath = path.join(
    here,
    '../../../../.localnet/dars/splice-token-test-trading-app-1.0.0.dar'
)
const tradingDarBytes = await fs.readFile(tradingDarPath)
await sdk.ledger.dar.upload(
    tradingDarBytes,
    'splice-token-test-trading-app',
    globalSyncId
)
logger.info('Uploaded trading-app DAR (global)')

// token-composition DAR (Token, TokenAllocation) – vetted on both syncs
const tokenCompositionDarPath = path.join(
    here,
    '../daml/token-composition/.daml/dist/token-composition-2.0.0.dar'
)
const tokenCompositionDarBytes = await fs.readFile(tokenCompositionDarPath)
await sdk.ledger.dar.upload(
    tokenCompositionDarBytes,
    'token-composition',
    globalSyncId
)
await sdk.ledger.dar.upload(
    tokenCompositionDarBytes,
    'token-composition',
    privateSyncId
)
logger.info('Uploaded token-composition DAR (global + private)')

// token-private DAR (TokenRules factory) – vetted on private only
const tokenPrivateDarPath = path.join(
    here,
    '../daml/token-private/.daml/dist/token-private-2.0.0.dar'
)
const tokenPrivateDarBytes = await fs.readFile(tokenPrivateDarPath)
await sdk.ledger.dar.upload(
    tokenPrivateDarBytes,
    'token-private',
    privateSyncId
)
logger.info('Uploaded token-private DAR (private)')

// ---------------------------------------------------------------------------
// 4. Allocate parties: Alice, Bob, Venue (admin)
// ---------------------------------------------------------------------------

const allocatedParties = await Promise.all(
    ['v1-13-alice', 'v1-13-bob', 'v1-13-venue'].map(async (partyHint) => {
        const partyKeys = sdk.keys.generate()

        // Register the party on the global synchronizer first
        const party = await sdk.party.external
            .create(partyKeys.publicKey, {
                partyHint,
                synchronizerId: globalSyncId,
            })
            .sign(partyKeys.privateKey)
            .execute()

        // Also register the same party on the private synchronizer
        // so it can transact on both syncs
        await sdk.party.external
            .create(partyKeys.publicKey, {
                partyHint,
                synchronizerId: privateSyncId,
            })
            .sign(partyKeys.privateKey)
            .execute({ forceAllocate: true, grantUserRights: false })

        return [
            partyHint,
            {
                partyId: party.partyId,
                publicKeyFingerprint: party.publicKeyFingerprint,
                multiHash: party.multiHash,
                topologyTransactions: party.topologyTransactions,
                keyPair: partyKeys,
            },
        ] as const
    })
)

const partyInfo: Map<string, PartyInfo> = new Map(allocatedParties)
const alice = partyInfo.get('v1-13-alice')!
const bob = partyInfo.get('v1-13-bob')!
const venue = partyInfo.get('v1-13-venue')!

logger.info(`Alice: ${alice.partyId}`)
logger.info(`Bob:   ${bob.partyId}`)
logger.info(`Venue: ${venue.partyId}`)

// ---------------------------------------------------------------------------
// 5. Create TokenRules factory on private sync (admin = venue).
//    The venue acts as the admin/issuer of the custom token instrument.
// ---------------------------------------------------------------------------

const INSTRUMENT_ID = 'PrivateToken'

const createTokenRulesCmd = {
    CreateCommand: {
        templateId: `#token-private:Demo.TokenPrivate:TokenRules`,
        createArguments: {
            admin: venue.partyId,
            instrumentId: INSTRUMENT_ID,
        },
    },
}

await sdk.ledger
    .prepare({
        partyId: venue.partyId,
        commands: createTokenRulesCmd,
        disclosedContracts: [],
        synchronizerId: privateSyncId,
    })
    .sign(venue.keyPair.privateKey)
    .execute({ partyId: venue.partyId })

logger.info('TokenRules factory created on private synchronizer')

// ---------------------------------------------------------------------------
// 6. Mint PrivateTokens for Bob on private sync (via TokenRules_Mint)
// ---------------------------------------------------------------------------

// Find the TokenRules contract
const tokenRulesContracts = await sdk.ledger.acs.read({
    templateIds: [`#token-private:Demo.TokenPrivate:TokenRules`],
    parties: [venue.partyId],
    filterByParty: true,
})
const tokenRulesEntry = tokenRulesContracts?.[0]?.contractEntry
if (!tokenRulesEntry || !('JsActiveContract' in tokenRulesEntry))
    throw new Error('TokenRules contract not found')
const tokenRulesCid = tokenRulesEntry.JsActiveContract.createdEvent.contractId
const tokenRulesDisclosed = {
    templateId: tokenRulesContracts[0].templateId,
    contractId: tokenRulesCid,
    createdEventBlob:
        tokenRulesEntry.JsActiveContract.createdEvent.createdEventBlob,
    synchronizerId: tokenRulesContracts[0].synchronizerId,
}

const mintCmd = {
    ExerciseCommand: {
        templateId: `#token-private:Demo.TokenPrivate:TokenRules`,
        contractId: tokenRulesCid,
        choice: 'TokenRules_Mint',
        choiceArgument: {
            recipient: bob.partyId,
            amount: '500',
        },
    },
}

await sdk.ledger
    .prepare({
        partyId: venue.partyId,
        commands: mintCmd,
        disclosedContracts: [],
        synchronizerId: privateSyncId,
    })
    .sign(venue.keyPair.privateKey)
    .execute({ partyId: venue.partyId })

logger.info('Minted 500 PrivateToken for Bob on private synchronizer')

// ---------------------------------------------------------------------------
// 7. Mint Amulet for Alice on global sync (via tap)
// ---------------------------------------------------------------------------

const [amuletTapCmd, amuletTapDisclosed] = await amulet.tap(
    alice.partyId,
    '2000000'
)

await sdk.ledger
    .prepare({
        partyId: alice.partyId,
        commands: amuletTapCmd,
        disclosedContracts: amuletTapDisclosed,
        ...(amuletTapDisclosed[0]?.synchronizerId && {
            synchronizerId: amuletTapDisclosed[0].synchronizerId,
        }),
    })
    .sign(alice.keyPair.privateKey)
    .execute({ partyId: alice.partyId })

logger.info('Minted Amulet for Alice on global synchronizer')

// ---------------------------------------------------------------------------
// 8. Trading App creates OTCTradeProposal on global sync
// ---------------------------------------------------------------------------

const amuletAsset = await asset.find(
    'Amulet',
    localNetStaticConfig.LOCALNET_REGISTRY_API_URL
)

const transferLegs = {
    leg0: {
        sender: bob.partyId,
        receiver: alice.partyId,
        amount: '100',
        instrumentId: { admin: venue.partyId, id: INSTRUMENT_ID },
        meta: { values: {} },
    },
    leg1: {
        sender: alice.partyId,
        receiver: bob.partyId,
        amount: '20',
        instrumentId: { admin: amuletAsset.admin, id: 'Amulet' },
        meta: { values: {} },
    },
}

const createProposalCmd = {
    CreateCommand: {
        templateId:
            '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTradeProposal',
        createArguments: {
            venue: venue.partyId,
            tradeCid: null,
            transferLegs,
            approvers: [alice.partyId],
        },
    },
}

await sdk.ledger
    .prepare({
        partyId: alice.partyId,
        commands: createProposalCmd,
        disclosedContracts: [],
        synchronizerId: globalSyncId,
    })
    .sign(alice.keyPair.privateKey)
    .execute({ partyId: alice.partyId })

logger.info('OTCTradeProposal created by Alice on global synchronizer')

// ---------------------------------------------------------------------------
// 9. Bob approves the trade proposal
// ---------------------------------------------------------------------------

const proposalsBob = await sdk.ledger.acs.read({
    templateIds: [
        '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTradeProposal',
    ],
    parties: [bob.partyId],
    filterByParty: true,
})

const proposalCidBob = getActiveContractCid(proposalsBob?.[0]?.contractEntry!)
if (!proposalCidBob) throw new Error('OTCTradeProposal not found for Bob')

await sdk.ledger
    .prepare({
        partyId: bob.partyId,
        commands: {
            ExerciseCommand: {
                templateId:
                    '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTradeProposal',
                contractId: proposalCidBob,
                choice: 'OTCTradeProposal_Accept',
                choiceArgument: { approver: bob.partyId },
            },
        },
        disclosedContracts: [],
        synchronizerId: globalSyncId,
    })
    .sign(bob.keyPair.privateKey)
    .execute({ partyId: bob.partyId })

logger.info('Bob approved OTCTradeProposal')

// ---------------------------------------------------------------------------
// 10. Venue initiates settlement → creates OTCTrade
// ---------------------------------------------------------------------------

const proposalsVenue = await sdk.ledger.acs.read({
    templateIds: [
        '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTradeProposal',
    ],
    parties: [venue.partyId],
    filterByParty: true,
})

const proposalCidVenue = getActiveContractCid(
    proposalsVenue?.[0]?.contractEntry!
)
if (!proposalCidVenue) throw new Error('OTCTradeProposal not found for Venue')

const now = new Date()
const prepareUntil = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
const settleBefore = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString()

await sdk.ledger
    .prepare({
        partyId: venue.partyId,
        commands: {
            ExerciseCommand: {
                templateId:
                    '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTradeProposal',
                contractId: proposalCidVenue,
                choice: 'OTCTradeProposal_InitiateSettlement',
                choiceArgument: { prepareUntil, settleBefore },
            },
        },
        disclosedContracts: [],
        synchronizerId: globalSyncId,
    })
    .sign(venue.keyPair.privateKey)
    .execute({ partyId: venue.partyId })

logger.info('Venue initiated settlement → OTCTrade created')

// Find the OTCTrade contract
const otcTrades = await sdk.ledger.acs.read({
    templateIds: [
        '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTrade',
    ],
    parties: [venue.partyId],
    filterByParty: true,
})

const otcTradeCid = getActiveContractCid(otcTrades?.[0]?.contractEntry!)
if (!otcTradeCid) throw new Error('OTCTrade not found for venue')

logger.info({ otcTradeCid }, 'OTCTrade found')

// ---------------------------------------------------------------------------
// 11. Bob allocates PrivateToken on private sync
//     Exercise AllocationFactory_Allocate on TokenRules to create TokenAllocation
// ---------------------------------------------------------------------------

// Retrieve Bob's pending allocation requests (from the OTCTrade AllocationRequest interface)
const pendingAllocationsBob = await token.allocation.request.pending(
    bob.partyId
)
const allocRequestViewBob = pendingAllocationsBob?.[0].interfaceViewValue!

// Find the leg where Bob is the sender
const legIdBob = Object.keys(allocRequestViewBob.transferLegs).find(
    (key) => allocRequestViewBob.transferLegs[key].sender === bob.partyId
)!
if (!legIdBob) throw new Error('No transfer leg found for Bob')

const legBob = allocRequestViewBob.transferLegs[legIdBob]

// Get Bob's Token holdings on private sync
const bobTokenContracts = await sdk.ledger.acs.read({
    templateIds: [`#token-composition:Demo.TokenComposition:Token`],
    parties: [bob.partyId],
    filterByParty: true,
})
const bobTokenCid = getActiveContractCid(bobTokenContracts?.[0]?.contractEntry!)
if (!bobTokenCid) throw new Error("Bob's Token holding not found")

// Exercise AllocationFactory_Allocate on TokenRules on the private sync
// Note: interface choices must use the interface ID as templateId
const allocateBobCmd = {
    ExerciseCommand: {
        templateId: `#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory`,
        contractId: tokenRulesCid,
        choice: 'AllocationFactory_Allocate',
        choiceArgument: {
            expectedAdmin: venue.partyId,
            allocation: {
                settlement: allocRequestViewBob.settlement,
                transferLegId: legIdBob,
                transferLeg: legBob,
            },
            requestedAt: new Date().toISOString(),
            inputHoldingCids: [bobTokenCid],
            extraArgs: {
                context: { values: {} },
                meta: { values: {} },
            },
        },
    },
}

await sdk.ledger
    .prepare({
        partyId: bob.partyId,
        commands: allocateBobCmd,
        disclosedContracts: [tokenRulesDisclosed],
        synchronizerId: privateSyncId,
    })
    .sign(bob.keyPair.privateKey)
    .execute({ partyId: bob.partyId })

logger.info('Bob allocated PrivateToken on private synchronizer')

// ---------------------------------------------------------------------------
// 12. Alice allocates Amulet on global sync (standard pattern from 04)
// ---------------------------------------------------------------------------

const pendingAllocationsAlice = await token.allocation.request.pending(
    alice.partyId
)
const allocRequestViewAlice = pendingAllocationsAlice?.[0].interfaceViewValue!

const legIdAlice = Object.keys(allocRequestViewAlice.transferLegs).find(
    (key) => allocRequestViewAlice.transferLegs[key].sender === alice.partyId
)!
if (!legIdAlice) throw new Error('No transfer leg found for Alice')

const legAlice = allocRequestViewAlice.transferLegs[legIdAlice]

const specAlice = {
    settlement: allocRequestViewAlice.settlement,
    transferLegId: legIdAlice,
    transferLeg: legAlice,
}

const [allocateCmdAlice, allocateDisclosedAlice] =
    await token.allocation.instruction.create({
        allocationSpecification: specAlice,
        asset: amuletAsset,
    })

await sdk.ledger
    .prepare({
        partyId: alice.partyId,
        commands: allocateCmdAlice,
        disclosedContracts: allocateDisclosedAlice,
        synchronizerId: globalSyncId,
    })
    .sign(alice.keyPair.privateKey)
    .execute({ partyId: alice.partyId })

logger.info('Alice allocated Amulet on global synchronizer')

// ---------------------------------------------------------------------------
// 13. Reassign Bob's TokenAllocation from private → global sync
// ---------------------------------------------------------------------------

// Find the TokenAllocation on private sync
const bobAllocationContracts = await sdk.ledger.acs.read({
    templateIds: [`#token-composition:Demo.TokenComposition:TokenAllocation`],
    parties: [bob.partyId],
    filterByParty: true,
})
const bobAllocationCid = getActiveContractCid(
    bobAllocationContracts?.[0]?.contractEntry!
)
if (!bobAllocationCid) throw new Error("Bob's TokenAllocation not found")

logger.info(
    `Reassigning TokenAllocation from ${privateSyncId} → ${globalSyncId}`
)

// Step 1: Unassign from private sync
const unassignResult = await sdk.ledger.unassign({
    submitter: bob.partyId,
    contractId: bobAllocationCid,
    source: privateSyncId,
    target: globalSyncId,
})

const unassignedEvent = unassignResult.reassignment.events.find(
    (e: Record<string, unknown>) => 'JsUnassignedEvent' in e
) as Record<string, any> | undefined

if (!unassignedEvent || !('JsUnassignedEvent' in unassignedEvent)) {
    throw new Error('No unassigned event found in reassignment result')
}

const reassignmentId =
    unassignedEvent.JsUnassignedEvent.value?.reassignmentId ??
    unassignedEvent.JsUnassignedEvent.reassignmentId
logger.info(`Unassigned. reassignmentId: ${reassignmentId}`)

// Step 2: Assign to global sync
const assignResult = await sdk.ledger.assign({
    submitter: bob.partyId,
    reassignmentId,
    source: privateSyncId,
    target: globalSyncId,
})

logger.info('TokenAllocation reassigned to global synchronizer')

// ---------------------------------------------------------------------------
// 14. Venue settles the OTCTrade on global sync
// ---------------------------------------------------------------------------

// Fetch all pending allocations visible to the venue
const allocationsVenue = await token.allocation.pending(venue.partyId)

const settlementRefId = allocRequestViewAlice.settlement.settlementRef.id
const relevantAllocations = allocationsVenue.filter(
    (a: any) =>
        a.interfaceViewValue.allocation.settlement.executor === venue.partyId &&
        a.interfaceViewValue.allocation.settlement.settlementRef.id ===
            settlementRefId
)

if (relevantAllocations.length === 0)
    throw new Error('No matching allocations for this trade')

logger.info(`Found ${relevantAllocations.length} allocations for settlement`)

// Build allocation entries with context for each leg
const allocationEntries = await Promise.all(
    relevantAllocations.map(async (a: any) => {
        const cid = a.contractId
        let choiceContext: any = {
            choiceContextData: { values: {} },
            disclosedContracts: [],
        }
        try {
            choiceContext = await token.allocation.context.execute(
                cid,
                localNetStaticConfig.LOCALNET_REGISTRY_API_URL
            )
        } catch {
            // TokenAllocation (non-amulet) may not have context endpoint – use empty
        }

        return {
            cid,
            legId: a.interfaceViewValue.allocation.transferLegId,
            extraArgs: {
                context: {
                    values: choiceContext.choiceContextData?.values ?? {},
                },
                meta: { values: {} },
            },
            disclosedContracts: choiceContext.disclosedContracts ?? [],
        }
    })
)

const allocationsWithContext: Record<string, { _1: string; _2: any }> =
    Object.fromEntries(
        allocationEntries.map((e) => [e.legId, { _1: e.cid, _2: e.extraArgs }])
    )

const uniqueDisclosedContracts = Array.from(
    new Map(
        allocationEntries
            .flatMap((e) => e.disclosedContracts)
            .map((d: any) => [d.contractId, d])
    ).values()
)

const settleCmd = {
    ExerciseCommand: {
        templateId:
            '#splice-token-test-trading-app:Splice.Testing.Apps.TradingApp:OTCTrade',
        contractId: otcTradeCid,
        choice: 'OTCTrade_Settle',
        choiceArgument: { allocationsWithContext },
    },
}

await sdk.ledger
    .prepare({
        partyId: venue.partyId,
        commands: settleCmd,
        disclosedContracts: uniqueDisclosedContracts,
        synchronizerId: globalSyncId,
    })
    .sign(venue.keyPair.privateKey)
    .execute({ partyId: venue.partyId })

logger.info(
    'Venue settled OTCTrade – holdings transferred (Alice ← Token, Bob ← Amulet)'
)

// ---------------------------------------------------------------------------
// 15. Verify final state
// ---------------------------------------------------------------------------

// Alice should now have a PrivateToken holding
const aliceTokens = await sdk.ledger.acs.read({
    templateIds: [`#token-composition:Demo.TokenComposition:Token`],
    parties: [alice.partyId],
    filterByParty: true,
})
logger.info(
    { count: aliceTokens?.length ?? 0 },
    'Alice PrivateToken holdings after settlement'
)

// Bob should now have Amulet
const bobAmulets = await token.utxos.list({ partyId: bob.partyId })
logger.info(
    { count: bobAmulets.length },
    'Bob Amulet holdings after settlement'
)

// Alice's remaining Amulet
const aliceAmulets = await token.utxos.list({ partyId: alice.partyId })
logger.info(
    { count: aliceAmulets.length },
    'Alice Amulet holdings after settlement'
)

logger.info('Cross-synchronizer reassignment scenario completed successfully')
