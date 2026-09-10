// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

import {IDIDRegistry} from "./interfaces/IDIDRegistry.sol";
import {IRoleManager} from "./interfaces/IRoleManager.sol";
import {IAuditTrail} from "./interfaces/IAuditTrail.sol";
import {AuditActions} from "./libraries/AuditActions.sol";

/**
 * @title AssetNFT
 * @notice Digital assets as ERC-721 tokens whose ownership is bound to
 *         decentralized identities rather than bare wallet addresses.
 *
 * Rules enforced on-chain
 * -----------------------
 * - Only ISSUER_ROLE can mint.
 * - The same content (by hash) cannot be minted twice: one asset, one token.
 * - A token can only ever be held by an account that has an active DID *and*
 *   USER_ROLE. That is checked on mint and on every transfer, for the recipient.
 * - The sender of a transfer must also have an active DID. Suspending an
 *   identity therefore freezes its assets in place, which stops a compromised
 *   key from draining them.
 * - Admins can freeze individual assets (disputes, legal hold).
 * - Every custody change is written to an on-chain provenance list and to the
 *   AuditTrail, on top of the standard ERC-721 Transfer event.
 *
 * All of this lives in `_update`, the single choke point through which every
 * mint, transfer, safeTransfer and burn in OpenZeppelin's ERC-721 must pass.
 * There is no way to move a token around these checks by calling a different
 * function.
 */
contract AssetNFT is ERC721, ERC721Enumerable, ERC721URIStorage {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant USER_ROLE = keccak256("USER_ROLE");

    struct Asset {
        bytes32 contentHash; // hash of the underlying digital asset / document
        string category;
        address issuer;
        uint64 createdAt;
        bool frozen;
    }

    struct ProvenanceRecord {
        address from; // address(0) on mint
        address to; // address(0) on retire
        address operator; // msg.sender that caused the move
        uint64 timestamp;
        uint64 blockNumber;
    }

    IDIDRegistry public immutable didRegistry;
    IRoleManager public immutable roleManager;
    IAuditTrail public auditTrail;

    uint256 private _nextTokenId = 1;
    mapping(uint256 => Asset) private _assets;
    mapping(uint256 => ProvenanceRecord[]) private _provenance;

    /// @notice contentHash => tokenId (0 when unminted). Blocks duplicate assets.
    mapping(bytes32 => uint256) public tokenByContentHash;

    error CallerLacksRole(bytes32 role, address caller);
    error IdentityNotVerified(address account);
    error RecipientLacksUserRole(address to);
    error AssetFrozen(uint256 tokenId);
    error DuplicateContent(bytes32 contentHash, uint256 existingTokenId);
    error EmptyContentHash();
    error NotOwnerNorAdmin(address caller, uint256 tokenId);
    error ZeroAddress();
    error AlreadySet();

    event AssetMinted(
        uint256 indexed tokenId,
        address indexed to,
        address indexed issuer,
        bytes32 contentHash,
        string category,
        string uri
    );
    event AssetFrozenSet(uint256 indexed tokenId, address indexed by, bool frozen);
    event AssetRetired(uint256 indexed tokenId, address indexed by, address indexed lastOwner);
    event AuditTrailSet(address indexed auditTrail);

    modifier onlyRole(bytes32 role) {
        if (!roleManager.hasValidRole(role, msg.sender)) revert CallerLacksRole(role, msg.sender);
        _;
    }

    constructor(address didRegistry_, address roleManager_) ERC721("YHack Digital Asset", "YHDA") {
        if (didRegistry_ == address(0) || roleManager_ == address(0)) revert ZeroAddress();
        didRegistry = IDIDRegistry(didRegistry_);
        roleManager = IRoleManager(roleManager_);
    }

    function setAuditTrail(address auditTrail_) external onlyRole(ADMIN_ROLE) {
        if (auditTrail_ == address(0)) revert ZeroAddress();
        if (address(auditTrail) != address(0)) revert AlreadySet();
        auditTrail = IAuditTrail(auditTrail_);
        emit AuditTrailSet(auditTrail_);
    }

    // --------------------------------------------------------------------
    // Lifecycle
    // --------------------------------------------------------------------

    /// @notice Create a new asset for `to`. Issuer only.
    function mint(address to, string calldata uri, bytes32 contentHash, string calldata category)
        external
        onlyRole(ISSUER_ROLE)
        returns (uint256 tokenId)
    {
        if (contentHash == bytes32(0)) revert EmptyContentHash();
        uint256 existing = tokenByContentHash[contentHash];
        if (existing != 0) revert DuplicateContent(contentHash, existing);

        tokenId = _nextTokenId++;
        _assets[tokenId] = Asset({
            contentHash: contentHash,
            category: category,
            issuer: msg.sender,
            createdAt: uint64(block.timestamp),
            frozen: false
        });
        tokenByContentHash[contentHash] = tokenId;

        _safeMint(to, tokenId); // recipient eligibility is checked inside _update
        _setTokenURI(tokenId, uri);

        emit AssetMinted(tokenId, to, msg.sender, contentHash, category, uri);
        _audit(AuditActions.ASSET_MINTED, msg.sender, to, tokenId, contentHash);
    }

    /// @notice Freeze or unfreeze an asset. Frozen assets cannot move. Admin only.
    function setFrozen(uint256 tokenId, bool frozen) external onlyRole(ADMIN_ROLE) {
        address owner = _requireOwned(tokenId);
        _assets[tokenId].frozen = frozen;

        emit AssetFrozenSet(tokenId, msg.sender, frozen);
        _audit(
            frozen ? AuditActions.ASSET_FROZEN : AuditActions.ASSET_UNFROZEN,
            msg.sender,
            owner,
            tokenId,
            bytes32(0)
        );
    }

    /// @notice Permanently retire (burn) an asset. Owner or admin.
    /// @dev The Asset record and provenance are intentionally kept so history survives.
    function retire(uint256 tokenId) external {
        address owner = _requireOwned(tokenId);
        bool isAdmin = roleManager.hasValidRole(ADMIN_ROLE, msg.sender);

        if (msg.sender != owner && !isAdmin) revert NotOwnerNorAdmin(msg.sender, tokenId);
        if (_assets[tokenId].frozen && !isAdmin) revert AssetFrozen(tokenId);

        bytes32 contentHash = _assets[tokenId].contentHash;
        delete tokenByContentHash[contentHash];

        _burn(tokenId);

        emit AssetRetired(tokenId, msg.sender, owner);
        _audit(AuditActions.ASSET_RETIRED, msg.sender, owner, tokenId, contentHash);
    }

    // --------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------

    function getAsset(uint256 tokenId) external view returns (Asset memory) {
        return _assets[tokenId];
    }

    function provenanceOf(uint256 tokenId) external view returns (ProvenanceRecord[] memory) {
        return _provenance[tokenId];
    }

    /// @notice The DID string of the current holder, linking asset to identity.
    function ownerDID(uint256 tokenId) external view returns (string memory) {
        return didRegistry.didOf(ownerOf(tokenId));
    }

    function assetsOf(address owner) external view returns (uint256[] memory tokenIds) {
        uint256 count = balanceOf(owner);
        tokenIds = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            tokenIds[i] = tokenOfOwnerByIndex(owner, i);
        }
    }

    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    // --------------------------------------------------------------------
    // The choke point
    // --------------------------------------------------------------------

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address from)
    {
        from = _ownerOf(tokenId);
        bool isTransfer = from != address(0) && to != address(0);

        if (isTransfer) {
            if (_assets[tokenId].frozen) revert AssetFrozen(tokenId);
            if (!didRegistry.isVerified(from)) revert IdentityNotVerified(from);
        }
        if (to != address(0)) {
            _requireEligibleHolder(to);
        }

        // ERC721 does the ownership / approval check and the actual bookkeeping.
        from = super._update(to, tokenId, auth);

        _provenance[tokenId].push(
            ProvenanceRecord({
                from: from,
                to: to,
                operator: msg.sender,
                timestamp: uint64(block.timestamp),
                blockNumber: uint64(block.number)
            })
        );

        if (isTransfer) {
            _audit(AuditActions.ASSET_TRANSFERRED, msg.sender, to, tokenId, bytes32(uint256(uint160(from))));
        }
    }

    function _requireEligibleHolder(address account) internal view {
        if (!didRegistry.isVerified(account)) revert IdentityNotVerified(account);
        if (!roleManager.hasValidRole(USER_ROLE, account)) revert RecipientLacksUserRole(account);
    }

    function _audit(bytes32 action, address actor, address subject, uint256 refId, bytes32 dataHash) internal {
        if (address(auditTrail) != address(0)) {
            auditTrail.record(action, actor, subject, refId, dataHash);
        }
    }

    // --------------------------------------------------------------------
    // Required overrides for the OpenZeppelin extension stack
    // --------------------------------------------------------------------

    function _increaseBalance(address account, uint128 value) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function tokenURI(uint256 tokenId) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable, ERC721URIStorage)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
