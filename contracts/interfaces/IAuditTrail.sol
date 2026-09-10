// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Append-only, hash-chained activity log.
interface IAuditTrail {
    function record(
        bytes32 action,
        address actor,
        address subject,
        uint256 refId,
        bytes32 dataHash
    ) external returns (uint256 entryId);
}
