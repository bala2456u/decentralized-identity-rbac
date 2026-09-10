// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Role surface consumed by the asset and permission layers.
/// @dev Callers must use `hasValidRole`, never the raw `hasRole` of AccessControl:
///      only `hasValidRole` also enforces role expiry and identity validity.
interface IRoleManager {
    function hasValidRole(bytes32 role, address account) external view returns (bool);

    function roleExpiry(bytes32 role, address account) external view returns (uint64);
}
