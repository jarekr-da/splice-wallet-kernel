// Copyright (c) 2025-2026 Digital Asset (Switzerland) GmbH and/or its affiliates. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type VetOptions = {
    /** Package IDs to vet on the target synchronizer. */
    packageIds: string[]
    /** The synchronizer on which to vet the packages. */
    synchronizerId: string
    /** Optional ISO-8601 timestamp from which vetting is valid. */
    validFrom?: string
    /** Optional ISO-8601 timestamp until which vetting is valid. */
    validUntil?: string
    /** Optional force flags to allow unsafe operations. */
    forceFlags?: VetForceFlag[]
}

export type UnvetOptions = {
    /** Package IDs to unvet on the target synchronizer. */
    packageIds: string[]
    /** The synchronizer on which to remove vetting. */
    synchronizerId: string
}

export type ListVettedOptions = {
    /** Filter by specific package IDs. */
    packageIds?: string[]
    /** Filter by package name prefixes. */
    packageNamePrefixes?: string[]
}

export type VetForceFlag =
    | 'UPDATE_VETTED_PACKAGES_FORCE_FLAG_ALLOW_VET_INCOMPATIBLE_UPGRADES'
    | 'UPDATE_VETTED_PACKAGES_FORCE_FLAG_ALLOW_UNVETTED_DEPENDENCIES'
