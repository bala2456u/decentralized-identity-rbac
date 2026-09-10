// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDIDRegistry} from "./interfaces/IDIDRegistry.sol";
import {IRoleManager} from "./interfaces/IRoleManager.sol";
import {IAuditTrail} from "./interfaces/IAuditTrail.sol";
import {AuditActions} from "./libraries/AuditActions.sol";

interface IRoleManagerOnboarding {
    function grantUserRoleFromOnboarding(address account, address approver) external;
}

/**
 * @title Onboarding
 * @notice Multi-stage, order-enforced approval workflow that turns a bare
 *         identity into an onboarded member of the organisation, and gives
 *         every identity a human-readable reference (Staff ID, name, department).
 *
 * The pipeline
 * ------------
 *   1. The applicant, who must already hold an active DID, submits their
 *      details: Staff ID, display name, department, and a fingerprint of the
 *      full onboarding form kept off-chain.            → PendingHOD
 *   2. The Head of the applicant's department approves. → PendingAdmin
 *   3. An admin gives final approval.                    → Approved
 *      The contract itself then grants USER_ROLE through RoleManager.
 *
 * What the contract guarantees
 * ----------------------------
 * - Stages cannot be skipped or reordered: each approval function checks the
 *   request is in exactly the stage it expects.
 * - The first approver must be the registered head of *that* department, and
 *   must currently hold a valid HOD_ROLE.
 * - Nobody can approve their own request.
 * - A Staff ID can belong to one identity only.
 * - Either approver can reject, with a reason that is kept on record. A
 *   rejected applicant may resubmit; the earlier attempt stays in the history.
 * - Every transition is written to the AuditTrail.
 *
 * Privileged staff (admins, issuers, heads of department) are set up by an
 * admin with `setProfileByAdmin`, which records a profile but grants no role.
 */
contract Onboarding {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant HOD_ROLE = keccak256("HOD_ROLE");

    enum Status {
        None,
        PendingHOD,
        PendingAdmin,
        Approved,
        Rejected
    }

    struct Request {
        address applicant;
        string staffId;
        string displayName;
        string department;
        bytes32 dataHash;
        Status status;
        uint64 submittedAt;
        address hodApprover;
        uint64 hodApprovedAt;
        address adminApprover;
        uint64 adminApprovedAt;
        address rejectedBy;
        string rejectReason;
    }

    IDIDRegistry public immutable didRegistry;
    IRoleManager public immutable roleManager;
    IAuditTrail public auditTrail;

    mapping(address => Request) private _requests;
    mapping(bytes32 => address) private _staffIdOwner; // keccak(staffId) => applicant
    mapping(bytes32 => address) private _departmentHead; // keccak(department) => head
    address[] private _applicants;

    error IdentityNotVerified(address account);
    error RequestExists(address applicant, Status status);
    error WrongStage(address applicant, Status expected, Status actual);
    error StaffIdTaken(string staffId, address owner);
    error EmptyField(string field);
    error CallerLacksRole(bytes32 role, address caller);
    error NotDepartmentHead(address caller, string department);
    error SelfApproval(address applicant);
    error NotAuthorizedToReject(address caller, address applicant);
    error NotHOD(address account);
    error ZeroAddress();
    error AlreadySet();

    event RequestSubmitted(address indexed applicant, string staffId, string displayName, string department, bytes32 dataHash);
    event RequestApprovedByHOD(address indexed applicant, address indexed hod);
    event RequestApproved(address indexed applicant, address indexed admin);
    event RequestRejected(address indexed applicant, address indexed by, Status stage, string reason);
    event ProfileSetByAdmin(address indexed account, address indexed admin, string staffId, string department);
    event DepartmentHeadSet(bytes32 indexed departmentKey, string department, address indexed head);
    event AuditTrailSet(address indexed auditTrail);

    modifier onlyRole(bytes32 role) {
        if (!roleManager.hasValidRole(role, msg.sender)) revert CallerLacksRole(role, msg.sender);
        _;
    }

    constructor(address didRegistry_, address roleManager_) {
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
    // Stage 0: the applicant submits
    // --------------------------------------------------------------------

    function submit(string calldata staffId, string calldata displayName, string calldata department, bytes32 dataHash)
        external
    {
        if (!didRegistry.isVerified(msg.sender)) revert IdentityNotVerified(msg.sender);
        if (bytes(staffId).length == 0) revert EmptyField("staffId");
        if (bytes(department).length == 0) revert EmptyField("department");

        Request storage existing = _requests[msg.sender];
        if (existing.status == Status.PendingHOD || existing.status == Status.PendingAdmin || existing.status == Status.Approved) {
            revert RequestExists(msg.sender, existing.status);
        }

        bytes32 sid = keccak256(bytes(staffId));
        address owner = _staffIdOwner[sid];
        if (owner != address(0) && owner != msg.sender) revert StaffIdTaken(staffId, owner);

        if (existing.status == Status.Rejected) {
            // resubmission: release the previous Staff ID in case it changed
            delete _staffIdOwner[keccak256(bytes(existing.staffId))];
        } else {
            _applicants.push(msg.sender);
        }
        _staffIdOwner[sid] = msg.sender;

        _requests[msg.sender] = Request({
            applicant: msg.sender,
            staffId: staffId,
            displayName: displayName,
            department: department,
            dataHash: dataHash,
            status: Status.PendingHOD,
            submittedAt: uint64(block.timestamp),
            hodApprover: address(0),
            hodApprovedAt: 0,
            adminApprover: address(0),
            adminApprovedAt: 0,
            rejectedBy: address(0),
            rejectReason: ""
        });

        emit RequestSubmitted(msg.sender, staffId, displayName, department, dataHash);
        _audit(AuditActions.ONBOARDING_SUBMITTED, msg.sender, msg.sender, 0, dataHash);
    }

    // --------------------------------------------------------------------
    // Stage 1: the Head of Department approves
    // --------------------------------------------------------------------

    function approveByHOD(address applicant) external onlyRole(HOD_ROLE) {
        Request storage r = _requireStage(applicant, Status.PendingHOD);
        if (applicant == msg.sender) revert SelfApproval(applicant);
        if (_departmentHead[keccak256(bytes(r.department))] != msg.sender) {
            revert NotDepartmentHead(msg.sender, r.department);
        }

        r.status = Status.PendingAdmin;
        r.hodApprover = msg.sender;
        r.hodApprovedAt = uint64(block.timestamp);

        emit RequestApprovedByHOD(applicant, msg.sender);
        _audit(AuditActions.ONBOARDING_HOD_APPROVED, msg.sender, applicant, 0, r.dataHash);
    }

    // --------------------------------------------------------------------
    // Stage 2: an admin gives final approval — USER_ROLE is granted here
    // --------------------------------------------------------------------

    function approveByAdmin(address applicant) external onlyRole(ADMIN_ROLE) {
        Request storage r = _requireStage(applicant, Status.PendingAdmin);
        if (applicant == msg.sender) revert SelfApproval(applicant);
        if (!didRegistry.isVerified(applicant)) revert IdentityNotVerified(applicant);

        r.status = Status.Approved;
        r.adminApprover = msg.sender;
        r.adminApprovedAt = uint64(block.timestamp);

        IRoleManagerOnboarding(address(roleManager)).grantUserRoleFromOnboarding(applicant, msg.sender);

        emit RequestApproved(applicant, msg.sender);
        _audit(AuditActions.ONBOARDING_APPROVED, msg.sender, applicant, 0, r.dataHash);
    }

    // --------------------------------------------------------------------
    // Rejection (either stage)
    // --------------------------------------------------------------------

    function reject(address applicant, string calldata reason) external {
        Request storage r = _requests[applicant];
        if (r.status != Status.PendingHOD && r.status != Status.PendingAdmin) {
            revert WrongStage(applicant, Status.PendingHOD, r.status);
        }

        bool isAdmin = roleManager.hasValidRole(ADMIN_ROLE, msg.sender);
        bool isDeptHead = r.status == Status.PendingHOD &&
            roleManager.hasValidRole(HOD_ROLE, msg.sender) &&
            _departmentHead[keccak256(bytes(r.department))] == msg.sender;
        if (!isAdmin && !isDeptHead) revert NotAuthorizedToReject(msg.sender, applicant);

        Status stage = r.status;
        r.status = Status.Rejected;
        r.rejectedBy = msg.sender;
        r.rejectReason = reason;

        emit RequestRejected(applicant, msg.sender, stage, reason);
        _audit(AuditActions.ONBOARDING_REJECTED, msg.sender, applicant, uint256(stage), keccak256(bytes(reason)));
    }

    // --------------------------------------------------------------------
    // Administration
    // --------------------------------------------------------------------

    /// @notice Appoint (or clear, with address(0)) the head of a department.
    function setDepartmentHead(string calldata department, address head) external onlyRole(ADMIN_ROLE) {
        if (bytes(department).length == 0) revert EmptyField("department");
        if (head != address(0) && !roleManager.hasValidRole(HOD_ROLE, head)) revert NotHOD(head);

        bytes32 key = keccak256(bytes(department));
        _departmentHead[key] = head;

        emit DepartmentHeadSet(key, department, head);
        _audit(AuditActions.DEPARTMENT_HEAD_SET, msg.sender, head, 0, key);
    }

    /// @notice Record a profile for privileged staff without running the workflow. Grants no role.
    function setProfileByAdmin(address account, string calldata staffId, string calldata displayName, string calldata department)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (!didRegistry.isVerified(account)) revert IdentityNotVerified(account);
        if (bytes(staffId).length == 0) revert EmptyField("staffId");

        Request storage existing = _requests[account];
        if (existing.status == Status.PendingHOD || existing.status == Status.PendingAdmin || existing.status == Status.Approved) {
            revert RequestExists(account, existing.status);
        }

        bytes32 sid = keccak256(bytes(staffId));
        address owner = _staffIdOwner[sid];
        if (owner != address(0) && owner != account) revert StaffIdTaken(staffId, owner);
        if (existing.status == Status.None) _applicants.push(account);
        _staffIdOwner[sid] = account;

        _requests[account] = Request({
            applicant: account,
            staffId: staffId,
            displayName: displayName,
            department: department,
            dataHash: bytes32(0),
            status: Status.Approved,
            submittedAt: uint64(block.timestamp),
            hodApprover: address(0),
            hodApprovedAt: 0,
            adminApprover: msg.sender,
            adminApprovedAt: uint64(block.timestamp),
            rejectedBy: address(0),
            rejectReason: ""
        });

        emit ProfileSetByAdmin(account, msg.sender, staffId, department);
        _audit(AuditActions.PROFILE_SET_BY_ADMIN, msg.sender, account, 0, sid);
    }

    // --------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------

    function getRequest(address applicant) external view returns (Request memory) {
        return _requests[applicant];
    }

    function statusOf(address applicant) external view returns (Status) {
        return _requests[applicant].status;
    }

    /// @notice Human-readable reference for an identity. Empty strings when none exists.
    function profileOf(address account)
        external
        view
        returns (string memory staffId, string memory displayName, string memory department, bool approved)
    {
        Request storage r = _requests[account];
        return (r.staffId, r.displayName, r.department, r.status == Status.Approved);
    }

    /// @notice Look an identity up by its Staff ID.
    function resolveStaffId(string calldata staffId) external view returns (address) {
        return _staffIdOwner[keccak256(bytes(staffId))];
    }

    function departmentHead(string calldata department) external view returns (address) {
        return _departmentHead[keccak256(bytes(department))];
    }

    function totalApplicants() external view returns (uint256) {
        return _applicants.length;
    }

    function applicantAt(uint256 index) external view returns (address) {
        return _applicants[index];
    }

    /// @notice Every request currently waiting at `stage` (PendingHOD or PendingAdmin).
    function pendingAt(Status stage) external view returns (address[] memory pending) {
        uint256 n;
        for (uint256 i = 0; i < _applicants.length; ++i) {
            if (_requests[_applicants[i]].status == stage) ++n;
        }
        pending = new address[](n);
        uint256 j;
        for (uint256 i = 0; i < _applicants.length; ++i) {
            if (_requests[_applicants[i]].status == stage) pending[j++] = _applicants[i];
        }
    }

    // --------------------------------------------------------------------
    // Internals
    // --------------------------------------------------------------------

    function _requireStage(address applicant, Status expected) internal view returns (Request storage r) {
        r = _requests[applicant];
        if (r.status != expected) revert WrongStage(applicant, expected, r.status);
    }

    function _audit(bytes32 action, address actor, address subject, uint256 refId, bytes32 dataHash) internal {
        if (address(auditTrail) != address(0)) {
            auditTrail.record(action, actor, subject, refId, dataHash);
        }
    }
}
