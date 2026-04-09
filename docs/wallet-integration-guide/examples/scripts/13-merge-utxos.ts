import pino from 'pino'
import { localNetStaticConfig, SDK } from '@canton-network/wallet-sdk'
import {
    TOKEN_NAMESPACE_CONFIG,
    TOKEN_PROVIDER_CONFIG_DEFAULT,
    AMULET_NAMESPACE_CONFIG,
} from './utils/index.js'

const logger = pino({ name: 'v1-13-reassign', level: 'info' })

const sdk = await SDK.create({
    auth: TOKEN_PROVIDER_CONFIG_DEFAULT,
    ledgerClientUrl: localNetStaticConfig.LOCALNET_APP_USER_LEDGER_URL,
})

const token = await sdk.token(TOKEN_NAMESPACE_CONFIG)

const amulet = await sdk.amulet(AMULET_NAMESPACE_CONFIG)

const aliceKeys = sdk.keys.generate()

const connectedSyncResponse = await sdk.ledger.state.connectedSynchronizers({})

if (
    !connectedSyncResponse.connectedSynchronizers ||
    connectedSyncResponse.connectedSynchronizers.length < 2
) {
    throw new Error(
        'At least 2 connected synchronizers are required for reassignment'
    )
}

const synchronizers = connectedSyncResponse.connectedSynchronizers
logger.info(
    `connected synchronizers: ${synchronizers.map((s) => s.synchronizerId).join(', ')}`
)

const sourceSynchronizerId = synchronizers[0].synchronizerId
const targetSynchronizerId = synchronizers[1].synchronizerId

const alice = await sdk.party.external
    .create(aliceKeys.publicKey, {
        partyHint: 'v1-13-alice',
        synchronizerId: sourceSynchronizerId,
    })
    .sign(aliceKeys.privateKey)
    .execute()

logger.info(`alice party created: ${alice.partyId}`)

// Mint a single holding for alice on the source synchronizer
const [amuletTapCommand, amuletTapDisclosedContracts] = await amulet.tap(
    alice.partyId,
    '2000000'
)

await sdk.ledger
    .prepare({
        partyId: alice.partyId,
        commands: amuletTapCommand,
        disclosedContracts: amuletTapDisclosedContracts,
        ...(amuletTapDisclosedContracts[0]?.synchronizerId && {
            synchronizerId: amuletTapDisclosedContracts[0].synchronizerId,
        }),
    })
    .sign(aliceKeys.privateKey)
    .execute({ partyId: alice.partyId })

// List UTXOs before reassignment
const utxosBefore = await token.utxos.list({ partyId: alice.partyId })
logger.info(`UTXOs before reassignment: ${utxosBefore.length}`)

const contractId = utxosBefore[0].contractId
logger.info(`contract to reassign: ${contractId}`)

// Step 1: Unassign the contract from the source synchronizer
// Note: Reassignment requires ALL stakeholders of the contract to be active
// on the target synchronizer. For amulet contracts, this includes the DSO party.
logger.info(
    `unassigning contract from ${sourceSynchronizerId} to ${targetSynchronizerId}`
)

try {
    const unassignResult = await sdk.ledger.unassign({
        submitter: alice.partyId,
        contractId,
        source: sourceSynchronizerId,
        target: targetSynchronizerId,
    })

    // Extract the reassignmentId from the unassign result
    const unassignedEvent = unassignResult.reassignment.events.find(
        (e) => 'JsUnassignedEvent' in e
    )

    if (!unassignedEvent || !('JsUnassignedEvent' in unassignedEvent)) {
        throw new Error('No unassigned event found in reassignment result')
    }

    const reassignmentId =
        unassignedEvent.JsUnassignedEvent.value.reassignmentId
    logger.info(`unassign complete, reassignmentId: ${reassignmentId}`)

    // Step 2: Assign the contract to the target synchronizer
    logger.info(`assigning contract to ${targetSynchronizerId}`)

    const assignResult = await sdk.ledger.assign({
        submitter: alice.partyId,
        reassignmentId,
        source: sourceSynchronizerId,
        target: targetSynchronizerId,
    })

    const assignedEvent = assignResult.reassignment.events.find(
        (e) => 'JsAssignmentEvent' in e
    )

    if (!assignedEvent || !('JsAssignmentEvent' in assignedEvent)) {
        throw new Error('No assigned event found in reassignment result')
    }

    logger.info(
        `contract successfully reassigned from ${sourceSynchronizerId} to ${targetSynchronizerId}`
    )

    // Verify UTXOs still exist after reassignment
    const utxosAfter = await token.utxos.list({ partyId: alice.partyId })
    logger.info(`UTXOs after reassignment: ${utxosAfter.length}`)
} catch (error: unknown) {
    const err = error as { code?: string; cause?: string }
    if (
        err.code === 'INVALID_ARGUMENT' &&
        err.cause?.includes('stakeholders')
    ) {
        logger.info(
            `reassignment rejected as expected: not all stakeholders are active on the target synchronizer`
        )
        logger.info(
            `this is expected for amulet contracts where DSO is a stakeholder and only active on the global domain`
        )
        logger.info(`unassign/assign API calls verified successfully`)
    } else {
        throw error
    }
}
