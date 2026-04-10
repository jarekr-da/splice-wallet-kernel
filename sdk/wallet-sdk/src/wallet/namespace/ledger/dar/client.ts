// Copyright (c) 2025-2026 Digital Asset (Switzerland) GmbH and/or its affiliates. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CommonCtx } from '../../../sdk.js'
import { Ops } from '@canton-network/core-provider-ledger'
import { VetOptions, UnvetOptions, ListVettedOptions } from './types.js'

export class Dar {
    constructor(private readonly sdkContext: CommonCtx) {}

    async upload(
        darBytes: Uint8Array | Buffer,
        packageId: string,
        synchronizerId?: string,
        vetAllPackages?: boolean
    ) {
        const isUploaded = await this.check(packageId)

        if (isUploaded) {
            this.sdkContext.logger.info(
                { packageId },
                'DAR already uploaded, skipping upload'
            )
            return
        }

        await this.sdkContext.ledgerProvider.request<Ops.PostV2Packages>({
            method: 'ledgerApi',
            params: {
                resource: '/v2/packages',
                requestMethod: 'post',
                query: {
                    synchronizerId:
                        synchronizerId ?? this.sdkContext.defaultSynchronizerId,
                    vetAllPackages: vetAllPackages ?? true,
                },
                body: darBytes as never,
                headers: { 'Content-Type': 'application/octet-stream' },
            },
        })
    }

    async check(packageId: string): Promise<boolean> {
        const result =
            await this.sdkContext.ledgerProvider.request<Ops.GetV2Packages>({
                method: 'ledgerApi',
                params: {
                    resource: '/v2/packages',
                    requestMethod: 'get',
                },
            })

        return (
            Array.isArray(result.packageIds) &&
            result.packageIds.includes(packageId)
        )
    }

    /**
     * Vet packages on a specific synchronizer.
     * Use after uploading a DAR with `vetAllPackages: false` to selectively
     * control which synchronizers can use the packages.
     */
    async vet(options: VetOptions) {
        return this.sdkContext.ledgerProvider.request<Ops.PostV2PackageVetting>(
            {
                method: 'ledgerApi',
                params: {
                    resource: '/v2/package-vetting',
                    requestMethod: 'post',
                    body: {
                        synchronizerId: options.synchronizerId,
                        changes: [
                            {
                                operation: {
                                    Vet: {
                                        value: {
                                            packages: options.packageIds.map(
                                                (packageId) => ({ packageId })
                                            ),
                                            ...(options.validFrom && {
                                                newValidFromInclusive:
                                                    options.validFrom,
                                            }),
                                            ...(options.validUntil && {
                                                newValidUntilExclusive:
                                                    options.validUntil,
                                            }),
                                        },
                                    },
                                },
                            },
                        ],
                        ...(options.forceFlags && {
                            updateVettedPackagesForceFlags: options.forceFlags,
                        }),
                    },
                },
            }
        )
    }

    /**
     * Remove vetting for packages on a specific synchronizer.
     */
    async unvet(options: UnvetOptions) {
        return this.sdkContext.ledgerProvider.request<Ops.PostV2PackageVetting>(
            {
                method: 'ledgerApi',
                params: {
                    resource: '/v2/package-vetting',
                    requestMethod: 'post',
                    body: {
                        synchronizerId: options.synchronizerId,
                        changes: [
                            {
                                operation: {
                                    Unvet: {
                                        value: {
                                            packages: options.packageIds.map(
                                                (packageId) => ({ packageId })
                                            ),
                                        },
                                    },
                                },
                            },
                        ],
                    },
                },
            }
        )
    }

    /**
     * List vetted packages, optionally filtered by package IDs or name prefixes.
     */
    async listVetted(options?: ListVettedOptions) {
        return this.sdkContext.ledgerProvider.request<Ops.GetV2PackageVetting>({
            method: 'ledgerApi',
            params: {
                resource: '/v2/package-vetting',
                requestMethod: 'get',
                body: {
                    ...(options?.packageIds || options?.packageNamePrefixes
                        ? {
                              packageMetadataFilter: {
                                  ...(options.packageIds && {
                                      packageIds: options.packageIds,
                                  }),
                                  ...(options.packageNamePrefixes && {
                                      packageNamePrefixes:
                                          options.packageNamePrefixes,
                                  }),
                              },
                          }
                        : {}),
                },
            },
        })
    }
}
