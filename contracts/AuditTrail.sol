// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAuditTrail} from "./interfaces/IAuditTrail.sol";

/**
 * @title AuditTrail
 * @notice Append-only activity log for identity, ownership and permission events.
 *
 * @dev Events alone already give an off-chain indexer a history, but they cannot
 *      prove that no entry was *omitted* when someone replays the log to you.
 *      Every entry here therefore commits to the hash of the entry before it, so
 *      the whole log is a hash chain: altering or dropping entry `n` changes every
 *      hash from `n` onward and `verifyChain` will report the exact break point.
 *
 *      There is deliberately no update or delete path. Not even the admin can
 *      rewrite an entry; the admin may only decide which contracts are allowed to
 *      append.
 */
contract AuditTrail is IAuditTrail {
    struct Entry {
        uint64 timestamp;
        uint64 blockNumber;
        address source; // contract that appended the entry
        address actor; // account that triggered the action
        address subject; // account the action was about (may equal actor)
        bytes32 action; // see libraries/AuditActions.sol
        uint256 refId; // tokenId / credential ref, 0 when not applicable
        bytes32 dataHash; // commitment to any off-chain detail
        bytes32 prevHash; // hash of the preceding entry (0 for the first)
        bytes32 entryHash;
    }

    address public admin;

    /// @notice Hash of the most recent entry; the tip of the chain.
    bytes32 public head;

    Entry[] private _entries;
    mapping(address => bool) public writers;
    mapping(address => uint256[]) private _byActor;
    mapping(address => uint256[]) private _bySubject;

    error NotAdmin(address caller);
    error NotWriter(address caller);
    error ZeroAddress();
    error RangeOutOfBounds(uint256 from, uint256 to);

    event WriterUpdated(address indexed writer, bool allowed);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event EntryRecorded(
        uint256 indexed entryId,
        bytes32 indexed action,
        address indexed actor,
        address subject,
        uint256 refId,
        bytes32 entryHash
    );

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    constructor(address initialAdmin) {
        if (initialAdmin == address(0)) revert ZeroAddress();
        admin = initialAdmin;
        emit AdminTransferred(address(0), initialAdmin);
    }

    // --------------------------------------------------------------------
    // Administration
    // --------------------------------------------------------------------

    /// @notice Allow or disallow a contract to append entries.
    function setWriter(address writer, bool allowed) external onlyAdmin {
        if (writer == address(0)) revert ZeroAddress();
        writers[writer] = allowed;
        emit WriterUpdated(writer, allowed);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        address previous = admin;
        admin = newAdmin;
        emit AdminTransferred(previous, newAdmin);
    }

    // --------------------------------------------------------------------
    // Writing
    // --------------------------------------------------------------------

    /// @inheritdoc IAuditTrail
    function record(
        bytes32 action,
        address actor,
        address subject,
        uint256 refId,
        bytes32 dataHash
    ) external returns (uint256 entryId) {
        if (!writers[msg.sender]) revert NotWriter(msg.sender);

        entryId = _entries.length;

        Entry memory entry = Entry({
            timestamp: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            source: msg.sender,
            actor: actor,
            subject: subject,
            action: action,
            refId: refId,
            dataHash: dataHash,
            prevHash: head,
            entryHash: bytes32(0)
        });
        entry.entryHash = _hashEntry(entry, entryId);

        _entries.push(entry);
        head = entry.entryHash;

        _byActor[actor].push(entryId);
        if (subject != actor) {
            _bySubject[subject].push(entryId);
        }

        emit EntryRecorded(entryId, action, actor, subject, refId, entry.entryHash);
    }

    // --------------------------------------------------------------------
    // Verification
    // --------------------------------------------------------------------

    /**
     * @notice Recompute the hash chain over [from, to] and report the first break.
     * @return ok       true when every entry in the range hashes correctly and
     *                  links to its predecessor.
     * @return brokenAt the id of the first inconsistent entry; meaningless if ok.
     */
    function verifyChain(uint256 from, uint256 to) external view returns (bool ok, uint256 brokenAt) {
        uint256 total = _entries.length;
        if (total == 0) return (true, 0);
        if (from > to || to >= total) revert RangeOutOfBounds(from, to);

        for (uint256 i = from; i <= to; ++i) {
            Entry memory entry = _entries[i];

            bytes32 expectedPrev = i == 0 ? bytes32(0) : _entries[i - 1].entryHash;
            if (entry.prevHash != expectedPrev) return (false, i);
            if (_hashEntry(entry, i) != entry.entryHash) return (false, i);
        }
        return (true, 0);
    }

    function _hashEntry(Entry memory entry, uint256 entryId) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    entry.prevHash,
                    entryId,
                    entry.timestamp,
                    entry.blockNumber,
                    entry.source,
                    entry.actor,
                    entry.subject,
                    entry.action,
                    entry.refId,
                    entry.dataHash
                )
            );
    }

    // --------------------------------------------------------------------
    // Reading
    // --------------------------------------------------------------------

    function totalEntries() external view returns (uint256) {
        return _entries.length;
    }

    function entryAt(uint256 entryId) external view returns (Entry memory) {
        return _entries[entryId];
    }

    /// @notice Page through the log. `count` is clamped to the end of the log.
    function getRange(uint256 from, uint256 count) external view returns (Entry[] memory page) {
        uint256 total = _entries.length;
        if (from >= total) return new Entry[](0);

        uint256 end = from + count;
        if (end > total) end = total;

        page = new Entry[](end - from);
        for (uint256 i = from; i < end; ++i) {
            page[i - from] = _entries[i];
        }
    }

    function entriesByActor(address actor) external view returns (uint256[] memory) {
        return _byActor[actor];
    }

    function entriesBySubject(address subject) external view returns (uint256[] memory) {
        return _bySubject[subject];
    }
}
