// Copyright (c) 2025-2026 Digital Asset (Switzerland) GmbH and/or its affiliates. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Build example DAML packages (token-composition, token-private).
 * These DARs are used in the wallet integration guide examples.
 */

import * as path from 'path'
import { getRepoRoot, info, success, error } from './lib/utils.js'
import { runDamlBuild } from './lib/daml-codegen.js'

const repoRoot = getRepoRoot()

const EXAMPLE_DARS = [
    {
        name: 'token-composition',
        path: path.join(
            repoRoot,
            'docs/wallet-integration-guide/examples/daml/token-composition'
        ),
    },
    {
        name: 'token-private',
        path: path.join(
            repoRoot,
            'docs/wallet-integration-guide/examples/daml/token-private'
        ),
    },
]

async function main() {
    console.log(info('\n=== Building Example DARs ===\n'))

    for (const dar of EXAMPLE_DARS) {
        console.log(info(`\nBuilding ${dar.name} at ${dar.path}...`))
        try {
            runDamlBuild(dar.path)
            console.log(success(`✓ Successfully built ${dar.name}`))
        } catch (err) {
            console.error(error(`✗ Failed to build ${dar.name}: ${err}`))
            throw err
        }
    }

    console.log(success('\n=== All example DARs built successfully ===\n'))
}

main().catch((err) => {
    console.error(error(`Build failed: ${err.message || err}`))
    process.exit(1)
})
