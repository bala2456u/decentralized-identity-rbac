// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title DocumentStore
 * @notice Content-addressed document storage on the ledger.
 *
 * Every other contract in this system records only a *fingerprint* (keccak256)
 * of a document and a link to where the full document lives. That is the right
 * default for anything private. But some documents are meant to be public and
 * verifiable by anyone — a DID document, a certificate, a published contract —
 * and for those, "somewhere off-chain" is a weak link: the file can go missing
 * or be swapped, and a verifier has to trust whoever serves it.
 *
 * This contract closes that gap. A document is stored under its own keccak256
 * hash, so the link `ledger://<hash>` *is* the fingerprint: fetching the bytes
 * and hashing them again proves they are exactly what was registered. Storing
 * the same content twice is a no-op, so anyone may re-store a document without
 * changing who is on record as the first to store it.
 *
 * Documents here are public forever. Callers must keep personal data out.
 */
contract DocumentStore {
    /// @notice Hard cap per document; large files belong off-chain, fingerprint-only.
    uint256 public constant MAX_BYTES = 24 * 1024;

    struct Meta {
        address storedBy;
        uint64 storedAt;
        uint32 size;
    }

    mapping(bytes32 => bytes) private _content;
    mapping(bytes32 => Meta) private _meta;
    uint256 public totalDocuments;

    error EmptyDocument();
    error DocumentTooLarge(uint256 size, uint256 max);

    event DocumentStored(bytes32 indexed hash, address indexed storedBy, uint256 size);

    /// @notice Store `content` and return its hash. Idempotent for identical content.
    function store(bytes calldata content) external returns (bytes32 hash) {
        if (content.length == 0) revert EmptyDocument();
        if (content.length > MAX_BYTES) revert DocumentTooLarge(content.length, MAX_BYTES);

        hash = keccak256(content);
        if (_meta[hash].storedAt != 0) return hash;

        _content[hash] = content;
        _meta[hash] = Meta({storedBy: msg.sender, storedAt: uint64(block.timestamp), size: uint32(content.length)});
        totalDocuments += 1;

        emit DocumentStored(hash, msg.sender, content.length);
    }

    /// @notice The document bytes for `hash`, or empty if nothing was stored under it.
    function get(bytes32 hash) external view returns (bytes memory) {
        return _content[hash];
    }

    function exists(bytes32 hash) external view returns (bool) {
        return _meta[hash].storedAt != 0;
    }

    function metaOf(bytes32 hash) external view returns (Meta memory) {
        return _meta[hash];
    }
}
