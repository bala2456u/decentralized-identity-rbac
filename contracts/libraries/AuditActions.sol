// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Canonical action codes written into the AuditTrail.
/// @dev Kept in one library so the frontend can decode an entry's `action`
///      field without guessing at ad-hoc strings scattered across contracts.
library AuditActions {
    bytes32 internal constant DID_REGISTERED    = keccak256("DID_REGISTERED");
    bytes32 internal constant DID_UPDATED       = keccak256("DID_UPDATED");
    bytes32 internal constant DID_DEACTIVATED   = keccak256("DID_DEACTIVATED");
    bytes32 internal constant DID_REACTIVATED   = keccak256("DID_REACTIVATED");
    bytes32 internal constant CONTROLLER_ROTATED = keccak256("CONTROLLER_ROTATED");

    bytes32 internal constant CREDENTIAL_ANCHORED = keccak256("CREDENTIAL_ANCHORED");
    bytes32 internal constant CREDENTIAL_REVOKED  = keccak256("CREDENTIAL_REVOKED");

    bytes32 internal constant ROLE_GRANTED = keccak256("ROLE_GRANTED");
    bytes32 internal constant ROLE_REVOKED = keccak256("ROLE_REVOKED");

    bytes32 internal constant ASSET_MINTED       = keccak256("ASSET_MINTED");
    bytes32 internal constant ASSET_TRANSFERRED  = keccak256("ASSET_TRANSFERRED");
    bytes32 internal constant ASSET_FROZEN       = keccak256("ASSET_FROZEN");
    bytes32 internal constant ASSET_UNFROZEN     = keccak256("ASSET_UNFROZEN");
    bytes32 internal constant ASSET_RETIRED      = keccak256("ASSET_RETIRED");

    bytes32 internal constant ACCESS_GRANTED = keccak256("ACCESS_GRANTED");
    bytes32 internal constant ACCESS_REVOKED = keccak256("ACCESS_REVOKED");
}
