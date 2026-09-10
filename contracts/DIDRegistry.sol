// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IDIDRegistry} from "./interfaces/IDIDRegistry.sol";
import {IRoleManager} from "./interfaces/IRoleManager.sol";
import {IAuditTrail} from "./interfaces/IAuditTrail.sol";
import {AuditActions} from "./libraries/AuditActions.sol";

/**
 * @title DIDRegistry
 * @notice Self-sovereign decentralized identifiers plus on-chain anchoring of
 *         verifiable credentials.
 *
 * Identity model
 * --------------
 * - A DID is derived from the subject's address: `did:yhack:<chainId>:<address>`.
 *   Nobody can register on someone else's behalf; only `msg.sender` can create
 *   its own identity. This is what makes the identity *self-sovereign*.
 * - The identity is soulbound by construction: it is keyed by the subject's
 *   address and there is no transfer function at all. Key rotation is handled
 *   by moving the *controller* (the key allowed to edit the DID document), not
 *   the identity itself.
 * - The DID document lives off-chain (IPFS / any URI). Only its hash is stored
 *   here, so it is tamper-evident without ever putting personal data on-chain.
 * - Deactivation by the subject can be reversed by the subject. Deactivation by
 *   an admin (e.g. compromised key, policy violation) can only be reversed by
 *   an admin.
 *
 * Credentials
 * -----------
 * An account holding ISSUER_ROLE signs an EIP-712 `Credential` claim about a
 * subject. Anyone can then anchor that signed claim on-chain; the contract
 * recovers the signer and refuses anything not signed by an active issuer.
 * Claims carry a per-issuer nonce, so the same signature can never be anchored
 * twice, and the EIP-712 domain binds them to this chain and this contract.
 */
contract DIDRegistry is IDIDRegistry, EIP712 {
    using Strings for uint256;
    using Strings for address;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    string public constant DID_METHOD = "yhack";

    bytes32 public constant CREDENTIAL_TYPEHASH =
        keccak256(
            "Credential(address issuer,address subject,bytes32 schema,bytes32 claimHash,uint64 expiresAt,uint256 nonce)"
        );

    struct Identity {
        bytes32 docHash;
        string docURI;
        address controller;
        uint64 createdAt;
        uint64 updatedAt;
        bool active;
        bool exists;
        bool adminLocked; // deactivated by an admin: only an admin may reactivate
    }

    struct Credential {
        address issuer;
        address subject;
        bytes32 schema;
        bytes32 claimHash;
        uint64 issuedAt;
        uint64 expiresAt; // 0 = never expires
        bool revoked;
        bool exists;
    }

    address public admin;
    IRoleManager public roleManager;
    IAuditTrail public auditTrail;

    mapping(address => Identity) private _identities;
    address[] private _subjects;

    mapping(bytes32 => Credential) private _credentials;
    mapping(address => bytes32[]) private _credentialsOf;

    /// @notice Next nonce each issuer must use. Prevents credential replay.
    mapping(address => uint256) public nonces;

    // --------------------------------------------------------------------
    // Errors & events
    // --------------------------------------------------------------------

    error NotAdmin(address caller);
    error NotController(address caller, address subject);
    error NotIssuer(address account);
    error NotCredentialIssuer(address caller, bytes32 credentialId);
    error AlreadyRegistered(address subject);
    error IdentityNotFound(address subject);
    error IdentityInactive(address subject);
    error IdentityAlreadyActive(address subject);
    error AdminLocked(address subject);
    error EmptyDocument();
    error ZeroAddress();
    error AlreadySet();
    error InvalidSignature();
    error BadNonce(uint256 expected, uint256 given);
    error ExpiryInPast(uint64 expiresAt);
    error CredentialNotFound(bytes32 credentialId);
    error CredentialAlreadyRevoked(bytes32 credentialId);

    event IdentityRegistered(address indexed subject, string did, bytes32 docHash, string docURI);
    event IdentityUpdated(address indexed subject, address indexed by, bytes32 docHash, string docURI);
    event IdentityDeactivated(address indexed subject, address indexed by, bool adminLocked);
    event IdentityReactivated(address indexed subject, address indexed by);
    event ControllerRotated(address indexed subject, address indexed previousController, address indexed newController);

    event CredentialAnchored(
        bytes32 indexed credentialId,
        address indexed issuer,
        address indexed subject,
        bytes32 schema,
        bytes32 claimHash,
        uint64 expiresAt
    );
    event CredentialRevoked(bytes32 indexed credentialId, address indexed by);

    event RoleManagerSet(address indexed roleManager);
    event AuditTrailSet(address indexed auditTrail);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // --------------------------------------------------------------------
    // Modifiers
    // --------------------------------------------------------------------

    modifier onlyAdmin() {
        if (!_isAdmin(msg.sender)) revert NotAdmin(msg.sender);
        _;
    }

    modifier onlyController(address subject) {
        Identity storage id = _identities[subject];
        if (!id.exists) revert IdentityNotFound(subject);
        if (msg.sender != id.controller) revert NotController(msg.sender, subject);
        _;
    }

    constructor(address initialAdmin) EIP712("YHackDIDRegistry", "1") {
        if (initialAdmin == address(0)) revert ZeroAddress();
        admin = initialAdmin;
        emit AdminTransferred(address(0), initialAdmin);
    }

    // --------------------------------------------------------------------
    // Wiring (one-time, admin only)
    // --------------------------------------------------------------------

    function setRoleManager(address roleManager_) external onlyAdmin {
        if (roleManager_ == address(0)) revert ZeroAddress();
        if (address(roleManager) != address(0)) revert AlreadySet();
        roleManager = IRoleManager(roleManager_);
        emit RoleManagerSet(roleManager_);
    }

    function setAuditTrail(address auditTrail_) external onlyAdmin {
        if (auditTrail_ == address(0)) revert ZeroAddress();
        if (address(auditTrail) != address(0)) revert AlreadySet();
        auditTrail = IAuditTrail(auditTrail_);
        emit AuditTrailSet(auditTrail_);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        address previous = admin;
        admin = newAdmin;
        emit AdminTransferred(previous, newAdmin);
    }

    // --------------------------------------------------------------------
    // Identity lifecycle
    // --------------------------------------------------------------------

    /// @notice Create the caller's own identity. One per address, forever.
    function register(string calldata docURI, bytes32 docHash) external returns (string memory did) {
        address subject = msg.sender;
        if (_identities[subject].exists) revert AlreadyRegistered(subject);
        if (docHash == bytes32(0)) revert EmptyDocument();

        uint64 nowTs = uint64(block.timestamp);
        _identities[subject] = Identity({
            docHash: docHash,
            docURI: docURI,
            controller: subject,
            createdAt: nowTs,
            updatedAt: nowTs,
            active: true,
            exists: true,
            adminLocked: false
        });
        _subjects.push(subject);

        did = didOf(subject);
        emit IdentityRegistered(subject, did, docHash, docURI);
        _audit(AuditActions.DID_REGISTERED, subject, subject, 0, docHash);
    }

    /// @notice Point the identity at a new DID document. Controller only.
    function updateDocument(address subject, bytes32 docHash, string calldata docURI)
        external
        onlyController(subject)
    {
        if (docHash == bytes32(0)) revert EmptyDocument();
        Identity storage id = _identities[subject];
        if (!id.active) revert IdentityInactive(subject);

        id.docHash = docHash;
        id.docURI = docURI;
        id.updatedAt = uint64(block.timestamp);

        emit IdentityUpdated(subject, msg.sender, docHash, docURI);
        _audit(AuditActions.DID_UPDATED, msg.sender, subject, 0, docHash);
    }

    /// @notice Hand control of the DID document to a new key (key rotation / recovery).
    function rotateController(address subject, address newController) external onlyController(subject) {
        if (newController == address(0)) revert ZeroAddress();
        Identity storage id = _identities[subject];
        if (!id.active) revert IdentityInactive(subject);

        address previous = id.controller;
        id.controller = newController;
        id.updatedAt = uint64(block.timestamp);

        emit ControllerRotated(subject, previous, newController);
        _audit(AuditActions.CONTROLLER_ROTATED, msg.sender, subject, 0, bytes32(uint256(uint160(newController))));
    }

    /// @notice Suspend an identity. Every role, asset transfer and permission tied to it stops working immediately.
    function deactivate(address subject) external {
        Identity storage id = _requireExists(subject);
        if (!id.active) revert IdentityInactive(subject);

        bool byAdmin = _isAdmin(msg.sender);
        if (!byAdmin && msg.sender != id.controller) revert NotController(msg.sender, subject);

        id.active = false;
        id.adminLocked = byAdmin;
        id.updatedAt = uint64(block.timestamp);

        emit IdentityDeactivated(subject, msg.sender, byAdmin);
        _audit(AuditActions.DID_DEACTIVATED, msg.sender, subject, 0, bytes32(0));
    }

    function reactivate(address subject) external {
        Identity storage id = _requireExists(subject);
        if (id.active) revert IdentityAlreadyActive(subject);

        bool byAdmin = _isAdmin(msg.sender);
        if (id.adminLocked && !byAdmin) revert AdminLocked(subject);
        if (!byAdmin && msg.sender != id.controller) revert NotController(msg.sender, subject);

        id.active = true;
        id.adminLocked = false;
        id.updatedAt = uint64(block.timestamp);

        emit IdentityReactivated(subject, msg.sender);
        _audit(AuditActions.DID_REACTIVATED, msg.sender, subject, 0, bytes32(0));
    }

    // --------------------------------------------------------------------
    // Identity views
    // --------------------------------------------------------------------

    /// @inheritdoc IDIDRegistry
    function isVerified(address account) public view returns (bool) {
        Identity storage id = _identities[account];
        return id.exists && id.active;
    }

    /// @inheritdoc IDIDRegistry
    /// @dev Returns an empty string for unregistered accounts rather than
    ///      fabricating a DID that does not exist.
    function didOf(address account) public view returns (string memory) {
        if (!_identities[account].exists) return "";
        return string.concat("did:", DID_METHOD, ":", block.chainid.toString(), ":", account.toHexString());
    }

    /// @inheritdoc IDIDRegistry
    function controllerOf(address account) external view returns (address) {
        return _identities[account].controller;
    }

    function getIdentity(address account) external view returns (Identity memory) {
        return _identities[account];
    }

    function totalIdentities() external view returns (uint256) {
        return _subjects.length;
    }

    function subjectAt(uint256 index) external view returns (address) {
        return _subjects[index];
    }

    // --------------------------------------------------------------------
    // Verifiable credentials
    // --------------------------------------------------------------------

    /// @notice Issue a credential directly from an issuer's own transaction.
    function issueCredential(address subject, bytes32 schema, bytes32 claimHash, uint64 expiresAt)
        external
        returns (bytes32 credentialId)
    {
        return _anchor(msg.sender, subject, schema, claimHash, expiresAt, nonces[msg.sender]);
    }

    /**
     * @notice Anchor a credential that the issuer signed off-chain (EIP-712).
     *         The submitter can be anyone, so the issuer never needs gas.
     */
    function anchorCredential(
        address issuer,
        address subject,
        bytes32 schema,
        bytes32 claimHash,
        uint64 expiresAt,
        uint256 nonce,
        bytes calldata signature
    ) external returns (bytes32 credentialId) {
        bytes32 digest = credentialDigest(issuer, subject, schema, claimHash, expiresAt, nonce);
        if (ECDSA.recover(digest, signature) != issuer) revert InvalidSignature();
        return _anchor(issuer, subject, schema, claimHash, expiresAt, nonce);
    }

    /// @notice The EIP-712 digest an issuer signs. Doubles as the credential id.
    function credentialDigest(
        address issuer,
        address subject,
        bytes32 schema,
        bytes32 claimHash,
        uint64 expiresAt,
        uint256 nonce
    ) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(CREDENTIAL_TYPEHASH, issuer, subject, schema, claimHash, expiresAt, nonce))
            );
    }

    function revokeCredential(bytes32 credentialId) external {
        Credential storage cred = _credentials[credentialId];
        if (!cred.exists) revert CredentialNotFound(credentialId);
        if (cred.revoked) revert CredentialAlreadyRevoked(credentialId);
        if (msg.sender != cred.issuer && !_isAdmin(msg.sender)) {
            revert NotCredentialIssuer(msg.sender, credentialId);
        }

        cred.revoked = true;
        emit CredentialRevoked(credentialId, msg.sender);
        _audit(AuditActions.CREDENTIAL_REVOKED, msg.sender, cred.subject, uint256(credentialId), bytes32(0));
    }

    /// @inheritdoc IDIDRegistry
    /// @dev A credential stays valid if the issuer later loses ISSUER_ROLE (it was
    ///      legitimately issued at the time) but not if the issuer's *identity*
    ///      is deactivated, which signals a compromised or untrusted key.
    function isCredentialValid(bytes32 credentialId) public view returns (bool) {
        Credential storage cred = _credentials[credentialId];
        if (!cred.exists || cred.revoked) return false;
        if (cred.expiresAt != 0 && cred.expiresAt <= block.timestamp) return false;
        return isVerified(cred.subject) && isVerified(cred.issuer);
    }

    function getCredential(bytes32 credentialId) external view returns (Credential memory) {
        return _credentials[credentialId];
    }

    function credentialsOf(address subject) external view returns (bytes32[] memory) {
        return _credentialsOf[subject];
    }

    // --------------------------------------------------------------------
    // Internals
    // --------------------------------------------------------------------

    function _anchor(
        address issuer,
        address subject,
        bytes32 schema,
        bytes32 claimHash,
        uint64 expiresAt,
        uint256 nonce
    ) internal returns (bytes32 credentialId) {
        if (!_isIssuer(issuer)) revert NotIssuer(issuer);
        _requireVerified(subject);
        if (nonce != nonces[issuer]) revert BadNonce(nonces[issuer], nonce);
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert ExpiryInPast(expiresAt);

        nonces[issuer] = nonce + 1;
        credentialId = credentialDigest(issuer, subject, schema, claimHash, expiresAt, nonce);

        _credentials[credentialId] = Credential({
            issuer: issuer,
            subject: subject,
            schema: schema,
            claimHash: claimHash,
            issuedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            revoked: false,
            exists: true
        });
        _credentialsOf[subject].push(credentialId);

        emit CredentialAnchored(credentialId, issuer, subject, schema, claimHash, expiresAt);
        _audit(AuditActions.CREDENTIAL_ANCHORED, issuer, subject, uint256(credentialId), claimHash);
    }

    function _requireExists(address subject) internal view returns (Identity storage id) {
        id = _identities[subject];
        if (!id.exists) revert IdentityNotFound(subject);
    }

    function _requireVerified(address subject) internal view {
        Identity storage id = _identities[subject];
        if (!id.exists) revert IdentityNotFound(subject);
        if (!id.active) revert IdentityInactive(subject);
    }

    function _isAdmin(address account) internal view returns (bool) {
        if (account == admin) return true;
        return address(roleManager) != address(0) && roleManager.hasValidRole(ADMIN_ROLE, account);
    }

    function _isIssuer(address account) internal view returns (bool) {
        return address(roleManager) != address(0) && roleManager.hasValidRole(ISSUER_ROLE, account);
    }

    function _audit(bytes32 action, address actor, address subject, uint256 refId, bytes32 dataHash) internal {
        if (address(auditTrail) != address(0)) {
            auditTrail.record(action, actor, subject, refId, dataHash);
        }
    }
}
