// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {IDIDRegistry} from "./interfaces/IDIDRegistry.sol";
import {IRoleManager} from "./interfaces/IRoleManager.sol";
import {IAuditTrail} from "./interfaces/IAuditTrail.sol";
import {AuditActions} from "./libraries/AuditActions.sol";

/**
 * @title AccessPolicy
 * @notice Per-asset permissions: who may VIEW, EDIT or MANAGE a given asset,
 *         separate from who *owns* it.
 *
 * Levels
 * ------
 *   0 NONE
 *   1 VIEW     read the asset
 *   2 EDIT     read + modify the asset
 *   3 MANAGE   read + modify + delegate VIEW/EDIT to others
 * The owner implicitly holds MANAGE and is the only one (besides an admin)
 * who can hand out MANAGE itself.
 *
 * Safety properties
 * -----------------
 * - Grants can be time-boxed and are individually revocable.
 * - A grant is pinned to the owner who was in place when it was made. When the
 *   asset is transferred, every existing grant lapses automatically; the new
 *   owner starts with a clean slate. No cross-contract callback is needed for
 *   this, it falls out of `effectiveLevel`.
 * - Grantees must hold an active DID. Deactivating an identity voids its
 *   permissions everywhere, instantly.
 * - Owners can authorise a grant off-chain with an EIP-712 signature and let
 *   anyone submit it (gasless for the owner). Signatures carry a nonce and a
 *   deadline and are bound to this chain and contract, so they cannot be
 *   replayed.
 */
contract AccessPolicy is EIP712 {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    uint8 public constant LEVEL_NONE = 0;
    uint8 public constant LEVEL_VIEW = 1;
    uint8 public constant LEVEL_EDIT = 2;
    uint8 public constant LEVEL_MANAGE = 3;

    bytes32 public constant GRANT_TYPEHASH =
        keccak256(
            "AccessGrant(uint256 tokenId,address grantee,uint8 level,uint64 expiresAt,uint256 nonce,uint256 deadline)"
        );

    struct Grant {
        uint8 level;
        uint64 grantedAt;
        uint64 expiresAt; // 0 = no expiry
        address grantedBy;
        address ownerAtGrant; // grant lapses once the asset changes hands
        bool revoked;
        bool exists;
    }

    /// @dev What an owner signs for a gasless grant.
    struct GrantRequest {
        uint256 tokenId;
        address grantee;
        uint8 level;
        uint64 expiresAt;
        uint256 nonce;
        uint256 deadline;
    }

    IDIDRegistry public immutable didRegistry;
    IRoleManager public immutable roleManager;
    IERC721 public immutable asset;
    IAuditTrail public auditTrail;

    mapping(uint256 => mapping(address => Grant)) private _grants;
    mapping(uint256 => address[]) private _grantees;

    /// @notice Next nonce each signer must use for `grantAccessWithSignature`.
    mapping(address => uint256) public nonces;

    error InvalidLevel(uint8 level);
    error ExpiryInPast(uint64 expiresAt);
    error GranteeIsOwner(uint256 tokenId, address grantee);
    error IdentityNotVerified(address account);
    error NotAuthorizedToGrant(address grantor, uint256 tokenId, uint8 level);
    error NotAuthorizedToRevoke(address caller, uint256 tokenId, address grantee);
    error NoActiveGrant(uint256 tokenId, address grantee);
    error SignatureExpired(uint256 deadline);
    error BadNonce(uint256 expected, uint256 given);
    error InvalidSignature();
    error CallerLacksRole(bytes32 role, address caller);
    error ZeroAddress();
    error AlreadySet();

    event AccessGranted(
        uint256 indexed tokenId,
        address indexed grantee,
        address indexed grantedBy,
        uint8 level,
        uint64 expiresAt
    );
    event AccessRevoked(uint256 indexed tokenId, address indexed grantee, address indexed revokedBy);
    event AuditTrailSet(address indexed auditTrail);

    modifier onlyRole(bytes32 role) {
        if (!roleManager.hasValidRole(role, msg.sender)) revert CallerLacksRole(role, msg.sender);
        _;
    }

    constructor(address didRegistry_, address roleManager_, address asset_) EIP712("YHackAccessPolicy", "1") {
        if (didRegistry_ == address(0) || roleManager_ == address(0) || asset_ == address(0)) revert ZeroAddress();
        didRegistry = IDIDRegistry(didRegistry_);
        roleManager = IRoleManager(roleManager_);
        asset = IERC721(asset_);
    }

    function setAuditTrail(address auditTrail_) external onlyRole(ADMIN_ROLE) {
        if (auditTrail_ == address(0)) revert ZeroAddress();
        if (address(auditTrail) != address(0)) revert AlreadySet();
        auditTrail = IAuditTrail(auditTrail_);
        emit AuditTrailSet(auditTrail_);
    }

    // --------------------------------------------------------------------
    // Granting
    // --------------------------------------------------------------------

    function grantAccess(uint256 tokenId, address grantee, uint8 level, uint64 expiresAt) external {
        _grant(tokenId, grantee, level, expiresAt, msg.sender);
    }

    /// @notice Submit a grant the owner (or another authorised grantor) signed off-chain.
    function grantAccessWithSignature(GrantRequest calldata req, address signer, bytes calldata signature)
        external
    {
        if (block.timestamp > req.deadline) revert SignatureExpired(req.deadline);
        if (req.nonce != nonces[signer]) revert BadNonce(nonces[signer], req.nonce);

        bytes32 digest = grantDigest(req);
        if (ECDSA.recover(digest, signature) != signer) revert InvalidSignature();

        nonces[signer] = req.nonce + 1;
        _grant(req.tokenId, req.grantee, req.level, req.expiresAt, signer);
    }

    /// @notice EIP-712 digest for a `GrantRequest`; what the signer actually signs.
    function grantDigest(GrantRequest calldata req) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        GRANT_TYPEHASH,
                        req.tokenId,
                        req.grantee,
                        req.level,
                        req.expiresAt,
                        req.nonce,
                        req.deadline
                    )
                )
            );
    }

    // --------------------------------------------------------------------
    // Revoking
    // --------------------------------------------------------------------

    function revokeAccess(uint256 tokenId, address grantee) external {
        Grant storage grant = _grants[tokenId][grantee];
        if (!grant.exists || grant.revoked) revert NoActiveGrant(tokenId, grantee);

        address owner = asset.ownerOf(tokenId);
        bool authorised = msg.sender == owner ||
            msg.sender == grant.grantedBy ||
            roleManager.hasValidRole(ADMIN_ROLE, msg.sender) ||
            (grant.level < LEVEL_MANAGE && effectiveLevel(tokenId, msg.sender) >= LEVEL_MANAGE);
        if (!authorised) revert NotAuthorizedToRevoke(msg.sender, tokenId, grantee);

        grant.revoked = true;

        emit AccessRevoked(tokenId, grantee, msg.sender);
        _audit(AuditActions.ACCESS_REVOKED, msg.sender, grantee, tokenId, bytes32(0));
    }

    // --------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------

    /// @notice The level `account` currently holds on `tokenId`, after every rule is applied.
    function effectiveLevel(uint256 tokenId, address account) public view returns (uint8) {
        address owner = asset.ownerOf(tokenId);
        if (account == owner) {
            return didRegistry.isVerified(owner) ? LEVEL_MANAGE : LEVEL_NONE;
        }
        if (!didRegistry.isVerified(account)) return LEVEL_NONE;

        Grant storage grant = _grants[tokenId][account];
        if (!grant.exists || grant.revoked) return LEVEL_NONE;
        if (grant.expiresAt != 0 && grant.expiresAt <= block.timestamp) return LEVEL_NONE;
        if (grant.ownerAtGrant != owner) return LEVEL_NONE; // asset changed hands

        return grant.level;
    }

    function hasAccess(uint256 tokenId, address account, uint8 level) external view returns (bool) {
        return effectiveLevel(tokenId, account) >= level;
    }

    function getGrant(uint256 tokenId, address grantee) external view returns (Grant memory) {
        return _grants[tokenId][grantee];
    }

    /// @notice Every address that was ever granted something on `tokenId`, including lapsed ones.
    function granteesOf(uint256 tokenId) external view returns (address[] memory) {
        return _grantees[tokenId];
    }

    /// @notice Only the grantees whose permission is currently in force.
    function activeGranteesOf(uint256 tokenId) external view returns (address[] memory active, uint8[] memory levels) {
        address[] storage all = _grantees[tokenId];
        uint256 n;
        for (uint256 i = 0; i < all.length; ++i) {
            if (effectiveLevel(tokenId, all[i]) > LEVEL_NONE) ++n;
        }

        active = new address[](n);
        levels = new uint8[](n);
        uint256 j;
        for (uint256 i = 0; i < all.length; ++i) {
            uint8 level = effectiveLevel(tokenId, all[i]);
            if (level > LEVEL_NONE) {
                active[j] = all[i];
                levels[j] = level;
                ++j;
            }
        }
    }

    // --------------------------------------------------------------------
    // Internals
    // --------------------------------------------------------------------

    function _grant(uint256 tokenId, address grantee, uint8 level, uint64 expiresAt, address grantor) internal {
        if (level == LEVEL_NONE || level > LEVEL_MANAGE) revert InvalidLevel(level);
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert ExpiryInPast(expiresAt);

        address owner = asset.ownerOf(tokenId); // reverts for a nonexistent token
        if (grantee == owner) revert GranteeIsOwner(tokenId, grantee);
        if (!didRegistry.isVerified(grantee)) revert IdentityNotVerified(grantee);
        if (!_canGrant(tokenId, grantor, owner, level)) revert NotAuthorizedToGrant(grantor, tokenId, level);

        if (!_grants[tokenId][grantee].exists) {
            _grantees[tokenId].push(grantee);
        }
        _grants[tokenId][grantee] = Grant({
            level: level,
            grantedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            grantedBy: grantor,
            ownerAtGrant: owner,
            revoked: false,
            exists: true
        });

        emit AccessGranted(tokenId, grantee, grantor, level, expiresAt);
        _audit(AuditActions.ACCESS_GRANTED, grantor, grantee, tokenId, bytes32(uint256(level)));
    }

    function _canGrant(uint256 tokenId, address grantor, address owner, uint8 level) internal view returns (bool) {
        if (grantor == owner) return didRegistry.isVerified(owner);
        if (roleManager.hasValidRole(ADMIN_ROLE, grantor)) return true;
        // Delegated management: MANAGE holders may hand out anything below MANAGE.
        return level < LEVEL_MANAGE && effectiveLevel(tokenId, grantor) >= LEVEL_MANAGE;
    }

    function _audit(bytes32 action, address actor, address subject, uint256 refId, bytes32 dataHash) internal {
        if (address(auditTrail) != address(0)) {
            auditTrail.record(action, actor, subject, refId, dataHash);
        }
    }
}
