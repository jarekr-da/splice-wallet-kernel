// Copyright (c) 2025-2026 Digital Asset (Switzerland) GmbH and/or its affiliates. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// DAR vetting scenario
//
// Demonstrates per-synchronizer DAR vetting using the SDK:
// 1. Upload DARs without auto-vetting
// 2. Selectively vet packages on specific synchronizers
// 3. List vetted packages and verify per-sync state
// 4. Unvet a package from one synchronizer
//
// Requires multi-sync localnet (at least 2 connected synchronizers).

import pino from 'pino'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import { localNetStaticConfig, SDK } from '@canton-network/wallet-sdk'
import { TOKEN_PROVIDER_CONFIG_DEFAULT } from './utils/index.js'

const logger = pino({ name: 'v1-14-vetting', level: 'info' })

// ---------------------------------------------------------------------------
// 1. SDK initialization
// ---------------------------------------------------------------------------

const sdk = await SDK.create({
    auth: TOKEN_PROVIDER_CONFIG_DEFAULT,
    ledgerClientUrl: localNetStaticConfig.LOCALNET_APP_USER_LEDGER_URL,
})

// ---------------------------------------------------------------------------
// 2. Discover synchronizers – require at least 2
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
const globalSyncId = synchronizers[0].synchronizerId
const privateSyncId = synchronizers[1].synchronizerId

logger.info(`Global synchronizer:  ${globalSyncId}`)
logger.info(`Private synchronizer: ${privateSyncId}`)

// ---------------------------------------------------------------------------
// 3. Upload DARs WITHOUT auto-vetting
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url))

// token-composition DAR
const TOKEN_COMPOSITION_PACKAGE_ID =
    'b1c0a5d4419e25c3d8b75083223c0ea949edda8f8e3a5475d117577cc95caa89'
const tokenCompositionDarPath = path.join(
    here,
    '../daml/token-composition/.daml/dist/token-composition-1.0.0.dar'
)
const tokenCompositionDarBytes = await fs.readFile(tokenCompositionDarPath)

// token-private DAR
const TOKEN_PRIVATE_PACKAGE_ID =
    'f158f3eb283e109f4449662821c27f1821b2c61ba36c8670743262c8db7bb4d1'
const tokenPrivateDarPath = path.join(
    here,
    '../daml/token-private/.daml/dist/token-private-1.0.0.dar'
)
const tokenPrivateDarBytes = await fs.readFile(tokenPrivateDarPath)

// Upload both DARs with vetAllPackages=false
await sdk.ledger.dar.upload(
    tokenCompositionDarBytes,
    TOKEN_COMPOSITION_PACKAGE_ID,
    undefined,
    false
)
logger.info('Uploaded token-composition DAR (no auto-vetting)')

await sdk.ledger.dar.upload(
    tokenPrivateDarBytes,
    TOKEN_PRIVATE_PACKAGE_ID,
    undefined,
    false
)
logger.info('Uploaded token-private DAR (no auto-vetting)')

// Verify packages are uploaded
const compositionUploaded = await sdk.ledger.dar.check(
    TOKEN_COMPOSITION_PACKAGE_ID
)
const privateUploaded = await sdk.ledger.dar.check(TOKEN_PRIVATE_PACKAGE_ID)
logger.info({ compositionUploaded, privateUploaded }, 'Package upload status')

// ---------------------------------------------------------------------------
// 4. List vetted packages BEFORE vetting — packages should NOT appear
// ---------------------------------------------------------------------------

const vettedBefore = await sdk.ledger.dar.listVetted({
    packageIds: [TOKEN_COMPOSITION_PACKAGE_ID, TOKEN_PRIVATE_PACKAGE_ID],
})
logger.info(
    {
        count: vettedBefore.vettedPackages?.length ?? 0,
        entries: vettedBefore.vettedPackages?.map((vp) => ({
            synchronizerId: vp.synchronizerId,
            packageCount: vp.packages.length,
        })),
    },
    'Vetted packages BEFORE selective vetting'
)

// ---------------------------------------------------------------------------
// 5. Vet token-composition on BOTH synchronizers
// ---------------------------------------------------------------------------

const vetCompositionGlobal = await sdk.ledger.dar.vet({
    packageIds: [TOKEN_COMPOSITION_PACKAGE_ID],
    synchronizerId: globalSyncId,
})
logger.info(
    {
        synchronizerId: globalSyncId,
        newPackageCount: vetCompositionGlobal.newVettedPackages.packages.length,
    },
    'Vetted token-composition on global sync'
)

const vetCompositionPrivate = await sdk.ledger.dar.vet({
    packageIds: [TOKEN_COMPOSITION_PACKAGE_ID],
    synchronizerId: privateSyncId,
})
logger.info(
    {
        synchronizerId: privateSyncId,
        newPackageCount:
            vetCompositionPrivate.newVettedPackages.packages.length,
    },
    'Vetted token-composition on private sync'
)

// ---------------------------------------------------------------------------
// 6. Vet token-private on PRIVATE sync ONLY
// ---------------------------------------------------------------------------

const vetPrivate = await sdk.ledger.dar.vet({
    packageIds: [TOKEN_PRIVATE_PACKAGE_ID],
    synchronizerId: privateSyncId,
})
logger.info(
    {
        synchronizerId: privateSyncId,
        newPackageCount: vetPrivate.newVettedPackages.packages.length,
    },
    'Vetted token-private on private sync ONLY'
)

// ---------------------------------------------------------------------------
// 7. List vetted packages AFTER vetting — verify per-sync state
// ---------------------------------------------------------------------------

const vettedAfter = await sdk.ledger.dar.listVetted({
    packageIds: [TOKEN_COMPOSITION_PACKAGE_ID, TOKEN_PRIVATE_PACKAGE_ID],
})

for (const vp of vettedAfter.vettedPackages ?? []) {
    const pkgIds = vp.packages.map((p) => p.packageId)
    const hasComposition = pkgIds.includes(TOKEN_COMPOSITION_PACKAGE_ID)
    const hasPrivate = pkgIds.includes(TOKEN_PRIVATE_PACKAGE_ID)
    logger.info(
        {
            synchronizerId: vp.synchronizerId,
            hasComposition,
            hasPrivate,
            totalPackages: vp.packages.length,
        },
        'Vetted packages on synchronizer'
    )
}

// ---------------------------------------------------------------------------
// 8. Unvet token-private from private sync (cleanup demo)
// ---------------------------------------------------------------------------

const unvetResult = await sdk.ledger.dar.unvet({
    packageIds: [TOKEN_PRIVATE_PACKAGE_ID],
    synchronizerId: privateSyncId,
})
logger.info(
    {
        synchronizerId: privateSyncId,
        remainingPackages: unvetResult.newVettedPackages.packages.length,
    },
    'Unvetted token-private from private sync'
)

// ---------------------------------------------------------------------------
// 9. Verify unvet took effect
// ---------------------------------------------------------------------------

const vettedFinal = await sdk.ledger.dar.listVetted({
    packageIds: [TOKEN_PRIVATE_PACKAGE_ID],
})

const privateStillVetted = (vettedFinal.vettedPackages ?? []).some((vp) =>
    vp.packages.some((p) => p.packageId === TOKEN_PRIVATE_PACKAGE_ID)
)
logger.info(
    { tokenPrivateStillVetted: privateStillVetted },
    'token-private vetting status after unvet'
)

logger.info('DAR vetting scenario completed successfully')
