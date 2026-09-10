// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view surface of the identity layer, consumed by every other contract.
interface IDIDRegistry {
    /// @return true only when the account has a registered, non-deactivated identity.
    function isVerified(address account) external view returns (bool);

    /// @return the fully qualified DID string, e.g. "did:yhack:11155111:0xabc...".
    function didOf(address account) external view returns (string memory);

    /// @return the key currently authorised to mutate the account's DID document.
    function controllerOf(address account) external view returns (address);

    /// @return true when the credential exists, is unexpired and has not been revoked.
    function isCredentialValid(bytes32 credentialId) external view returns (bool);
}
