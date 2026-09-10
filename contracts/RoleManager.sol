// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IRoleManager} from "./interfaces/IRoleManager.sol";
import {IDIDRegistry} from "./interfaces/IDIDRegistry.sol";
import {IAuditTrail} from "./interfaces/IAuditTrail.sol";
import {AuditActions} from "./libraries/AuditActions.sol";

/**
 * @title RoleManager
 * @notice Role-Based Access Control bound to decentralized identities.
 *
 * Roles
 * -----
 *   DEFAULT_ADMIN_ROLE  can grant/revoke ADMIN_ROLE                     (root key)
 *   ADMIN_ROLE          can grant/revoke ISSUER / AUDITOR / HOD / USER  (operators)
 *   ISSUER_ROLE         can mint assets and sign credentials
 *   AUDITOR_ROLE        read-only privileged views in the dApp
 *   HOD_ROLE            Head of Department: first-stage onboarding approver
 *   USER_ROLE           can hold and receive assets
 *
 * Rules
 * -----
 * 1. No identity, no role. A role can only be granted to an account whose DID
 *    is registered and active. This is enforced in `_grantRole`, so there is no
 *    code path that bypasses it, including the constructor.
 * 2. Roles may carry an expiry. An expired role is treated as absent.
 * 3. Deactivating an identity instantly voids every role it holds, without an
 *    admin having to revoke them one by one. Reactivating restores them.
 * 4. Callers must check `hasValidRole`, never the raw `hasRole`. `hasRole` is
 *    left untouched only so that AccessControl's own bookkeeping keeps working
 *    (for example, revoking a role from an account whose identity is currently
 *    suspended).
 * 5. USER_ROLE can also be granted by the Onboarding contract, and only by it,
 *    when a request has passed every approval stage. That is the only role a
 *    contract can grant, and it cannot revoke anything.
 *
 * Recovery
 * --------
 * Because rule 3 applies to admins too, an admin whose identity is deactivated
 * loses their powers here. Recovery goes through `DIDRegistry.admin`, which is
 * a plain address check and is not identity-gated.
 */
contract RoleManager is AccessControl, IRoleManager {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 public constant HOD_ROLE = keccak256("HOD_ROLE");
    bytes32 public constant USER_ROLE = keccak256("USER_ROLE");

    IDIDRegistry public didRegistry;
    IAuditTrail public auditTrail;

    /// @notice The Onboarding workflow contract allowed to grant USER_ROLE on final approval.
    address public onboarding;

    /// @dev role => account => unix expiry (0 = no expiry)
    mapping(bytes32 => mapping(address => uint64)) private _expiry;

    error IdentityNotVerified(address account);
    error ExpiryInPast(uint64 expiresAt);
    error CallerLacksValidRole(bytes32 role, address caller);
    error NotOnboarding(address caller);
    error ZeroAddress();
    error AlreadySet();

    event RoleExpirySet(bytes32 indexed role, address indexed account, uint64 expiresAt);
    event AuditTrailSet(address indexed auditTrail);
    event OnboardingSet(address indexed onboarding);

    /// @dev Like OpenZeppelin's `onlyRole`, but expiry- and identity-aware.
    modifier onlyValidRole(bytes32 role) {
        if (!hasValidRole(role, msg.sender)) revert CallerLacksValidRole(role, msg.sender);
        _;
    }

    constructor(address initialAdmin, address didRegistry_) {
        if (initialAdmin == address(0) || didRegistry_ == address(0)) revert ZeroAddress();
        didRegistry = IDIDRegistry(didRegistry_);

        _setRoleAdmin(ADMIN_ROLE, DEFAULT_ADMIN_ROLE);
        _setRoleAdmin(ISSUER_ROLE, ADMIN_ROLE);
        _setRoleAdmin(AUDITOR_ROLE, ADMIN_ROLE);
        _setRoleAdmin(HOD_ROLE, ADMIN_ROLE);
        _setRoleAdmin(USER_ROLE, ADMIN_ROLE);

        // Goes through the overridden _grantRole: the admin must already hold a DID.
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(ADMIN_ROLE, initialAdmin);
    }

    // --------------------------------------------------------------------
    // Wiring (one-time, root admin only)
    // --------------------------------------------------------------------

    function setAuditTrail(address auditTrail_) external onlyValidRole(DEFAULT_ADMIN_ROLE) {
        if (auditTrail_ == address(0)) revert ZeroAddress();
        if (address(auditTrail) != address(0)) revert AlreadySet();
        auditTrail = IAuditTrail(auditTrail_);
        emit AuditTrailSet(auditTrail_);
    }

    function setOnboarding(address onboarding_) external onlyValidRole(DEFAULT_ADMIN_ROLE) {
        if (onboarding_ == address(0)) revert ZeroAddress();
        if (onboarding != address(0)) revert AlreadySet();
        onboarding = onboarding_;
        emit OnboardingSet(onboarding_);
    }

    // --------------------------------------------------------------------
    // Granting / revoking
    // --------------------------------------------------------------------

    /// @notice Grant a role with no expiry. Caller must validly hold the role's admin role.
    function grantRole(bytes32 role, address account) public override onlyValidRole(getRoleAdmin(role)) {
        _grantWithExpiry(role, account, 0, msg.sender);
    }

    /// @notice Grant a role that silently lapses at `expiresAt`.
    function grantRoleWithExpiry(bytes32 role, address account, uint64 expiresAt)
        external
        onlyValidRole(getRoleAdmin(role))
    {
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert ExpiryInPast(expiresAt);
        _grantWithExpiry(role, account, expiresAt, msg.sender);
    }

    function revokeRole(bytes32 role, address account) public override onlyValidRole(getRoleAdmin(role)) {
        delete _expiry[role][account];
        _revokeRole(role, account);
        _audit(AuditActions.ROLE_REVOKED, msg.sender, account, uint256(role), bytes32(0));
    }

    /**
     * @notice Grant USER_ROLE to an applicant whose onboarding request has passed
     *         its final approval. Only the Onboarding contract may call this.
     * @param account  the newly onboarded person
     * @param approver the admin who gave the final approval, recorded as the actor
     */
    function grantUserRoleFromOnboarding(address account, address approver) external {
        if (msg.sender != onboarding) revert NotOnboarding(msg.sender);
        _grantWithExpiry(USER_ROLE, account, 0, approver);
    }

    // --------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------

    /// @inheritdoc IRoleManager
    function hasValidRole(bytes32 role, address account) public view returns (bool) {
        if (!hasRole(role, account)) return false;

        uint64 expiresAt = _expiry[role][account];
        if (expiresAt != 0 && expiresAt <= block.timestamp) return false;

        return didRegistry.isVerified(account);
    }

    /// @inheritdoc IRoleManager
    function roleExpiry(bytes32 role, address account) external view returns (uint64) {
        return _expiry[role][account];
    }

    /// @notice Convenience for UIs: every role of an account in one call.
    function rolesOf(address account)
        external
        view
        returns (bool isRootAdmin, bool isAdmin, bool isIssuer, bool isAuditor, bool isHod, bool isUser)
    {
        isRootAdmin = hasValidRole(DEFAULT_ADMIN_ROLE, account);
        isAdmin = hasValidRole(ADMIN_ROLE, account);
        isIssuer = hasValidRole(ISSUER_ROLE, account);
        isAuditor = hasValidRole(AUDITOR_ROLE, account);
        isHod = hasValidRole(HOD_ROLE, account);
        isUser = hasValidRole(USER_ROLE, account);
    }

    // --------------------------------------------------------------------
    // Internals
    // --------------------------------------------------------------------

    /// @dev Single choke point: every grant, from any path, requires a live identity.
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (!didRegistry.isVerified(account)) revert IdentityNotVerified(account);
        return super._grantRole(role, account);
    }

    function _grantWithExpiry(bytes32 role, address account, uint64 expiresAt, address actor) internal {
        _grantRole(role, account);
        _expiry[role][account] = expiresAt;
        emit RoleExpirySet(role, account, expiresAt);
        _audit(AuditActions.ROLE_GRANTED, actor, account, uint256(role), bytes32(uint256(expiresAt)));
    }

    function _audit(bytes32 action, address actor, address subject, uint256 refId, bytes32 dataHash) internal {
        if (address(auditTrail) != address(0)) {
            auditTrail.record(action, actor, subject, refId, dataHash);
        }
    }
}
