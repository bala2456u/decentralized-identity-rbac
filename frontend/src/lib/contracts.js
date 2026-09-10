import { Contract, Interface, ZeroHash, id } from "ethers";

import deployments from "../deployments.json";
import DIDRegistry from "../abi/DIDRegistry.json";
import RoleManager from "../abi/RoleManager.json";
import AuditTrail from "../abi/AuditTrail.json";
import AssetNFT from "../abi/AssetNFT.json";
import AccessPolicy from "../abi/AccessPolicy.json";
import Onboarding from "../abi/Onboarding.json";

export const ABIS = { DIDRegistry, RoleManager, AuditTrail, AssetNFT, AccessPolicy, Onboarding };

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLES = {
  DEFAULT_ADMIN: ZeroHash,
  ADMIN: id("ADMIN_ROLE"),
  ISSUER: id("ISSUER_ROLE"),
  AUDITOR: id("AUDITOR_ROLE"),
  HOD: id("HOD_ROLE"),
  USER: id("USER_ROLE"),
};

/** Plain-English names and one-line explanations for every role. */
export const ROLE_INFO = {
  [ROLES.DEFAULT_ADMIN]: { label: "Root admin", desc: "Appoints and removes admins. The master key." },
  [ROLES.ADMIN]: { label: "Admin", desc: "Gives and removes roles, gives final onboarding approval, can suspend an ID and freeze an asset." },
  [ROLES.ISSUER]: { label: "Issuer", desc: "Registers new assets and issues certificates about people." },
  [ROLES.AUDITOR]: { label: "Auditor", desc: "Oversight only. Can look at everything, cannot own assets." },
  [ROLES.HOD]: { label: "Head of Dept", desc: "Gives the first approval to onboarding requests from their own department." },
  [ROLES.USER]: { label: "User", desc: "Can own, receive and share assets. Granted automatically when onboarding is approved." },
};

export const roleName = (role) => ROLE_INFO[role]?.label ?? short(role);

export const GRANTABLE_ROLES = [ROLES.ADMIN, ROLES.ISSUER, ROLES.AUDITOR, ROLES.HOD, ROLES.USER];

// ---------------------------------------------------------------------------
// Access levels
// ---------------------------------------------------------------------------

export const LEVEL_INFO = [
  { label: "No access", desc: "Cannot see this asset." },
  { label: "View", desc: "Can open and read the asset." },
  { label: "Edit", desc: "Can read and change the asset." },
  { label: "Manage", desc: "Can read, change, and share View or Edit access with others." },
];
export const LEVELS = LEVEL_INFO.map((l) => l.label);

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export const STATUS = { NONE: 0, PENDING_HOD: 1, PENDING_ADMIN: 2, APPROVED: 3, REJECTED: 4 };
export const STATUS_LABEL = ["Not submitted", "Waiting for Head of Department", "Waiting for admin", "Approved", "Rejected"];
export const DEPARTMENTS = ["Procurement", "Finance", "Administration", "Records Office", "Internal Audit", "Engineering", "HR"];

// ---------------------------------------------------------------------------
// History actions
// ---------------------------------------------------------------------------

const ACTIONS = {
  DID_REGISTERED: "Digital ID created",
  DID_UPDATED: "Digital ID updated",
  DID_DEACTIVATED: "Digital ID suspended",
  DID_REACTIVATED: "Digital ID reactivated",
  CONTROLLER_ROTATED: "Control key moved",
  CREDENTIAL_ANCHORED: "Certificate issued",
  CREDENTIAL_REVOKED: "Certificate revoked",
  ROLE_GRANTED: "Role given",
  ROLE_REVOKED: "Role removed",
  ONBOARDING_SUBMITTED: "Onboarding submitted",
  ONBOARDING_HOD_APPROVED: "Approved by Head of Dept",
  ONBOARDING_APPROVED: "Onboarding approved",
  ONBOARDING_REJECTED: "Onboarding rejected",
  PROFILE_SET_BY_ADMIN: "Staff profile set by admin",
  DEPARTMENT_HEAD_SET: "Department head appointed",
  ASSET_MINTED: "Asset registered",
  ASSET_TRANSFERRED: "Asset transferred",
  ASSET_FROZEN: "Asset frozen",
  ASSET_UNFROZEN: "Asset unfrozen",
  ASSET_RETIRED: "Asset retired",
  ACCESS_GRANTED: "Access shared",
  ACCESS_REVOKED: "Access removed",
};
export const ACTION_LABEL = Object.fromEntries(Object.entries(ACTIONS).map(([code, label]) => [id(code), label]));
export const ACTION_CODE = Object.fromEntries(Object.keys(ACTIONS).map((code) => [id(code), code]));

export const CHAIN_NAMES = {
  31337: "Local test network",
  11155111: "Sepolia test network",
  80002: "Polygon Amoy test network",
};

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export function getDeployment(chainId) {
  return deployments[String(chainId)] ?? null;
}

export function makeContracts(runner, deployment) {
  const c = deployment.contracts;
  return {
    did: new Contract(c.DIDRegistry, DIDRegistry, runner),
    roles: new Contract(c.RoleManager, RoleManager, runner),
    audit: new Contract(c.AuditTrail, AuditTrail, runner),
    nft: new Contract(c.AssetNFT, AssetNFT, runner),
    policy: new Contract(c.AccessPolicy, AccessPolicy, runner),
    onboarding: c.Onboarding ? new Contract(c.Onboarding, Onboarding, runner) : null,
  };
}

// ---------------------------------------------------------------------------
// Errors → plain English
// ---------------------------------------------------------------------------

// One interface holding every custom error from every contract, so a revert
// raised deep inside a nested call still decodes to a readable name.
const seen = new Set();
const errorFragments = Object.values(ABIS)
  .flat()
  .filter((f) => f.type === "error")
  .filter((f) => {
    const key = `${f.name}(${f.inputs.map((i) => i.type).join(",")})`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
const errorIface = new Interface(errorFragments);

/** What each contract refusal means, in a sentence a new user can act on. */
const FRIENDLY = {
  AlreadyRegistered: () => "This account already has a Digital ID. Each account can only have one.",
  IdentityNotFound: ([a]) => `${short(a)} has no Digital ID yet. They need to create one first.`,
  IdentityNotVerified: ([a]) =>
    `${short(a)} has no active Digital ID. They must create one (or an admin must reactivate it) before this can happen.`,
  IdentityInactive: ([a]) => `The Digital ID of ${short(a)} is currently suspended.`,
  IdentityAlreadyActive: () => "This Digital ID is already active.",
  AdminLocked: () => "This Digital ID was suspended by an admin, so only an admin can reactivate it.",
  NotController: ([, subject]) => `Only the person controlling ${short(subject)}'s Digital ID can change it.`,
  NotAdmin: () => "Only an admin can do this.",
  NotIssuer: ([a]) => `${short(a)} is not an Issuer, so they cannot issue certificates.`,
  NotCredentialIssuer: () => "Only the issuer of this certificate, or an admin, can revoke it.",
  EmptyDocument: () => "Please enter the document content. Its fingerprint is what gets recorded.",
  EmptyContentHash: () => "Please enter the asset content. Its fingerprint is what gets recorded.",
  InvalidSignature: () => "The signature doesn't match the person it claims to be from.",
  BadNonce: () => "This signed permission was already used, or is out of order. Ask for a fresh signature.",
  SignatureExpired: () => "This signed permission has expired. Ask for a fresh signature.",
  ExpiryInPast: () => "That expiry date is in the past. Choose a future date, or leave it empty for no expiry.",
  CredentialNotFound: () => "No certificate with that ID exists.",
  CredentialAlreadyRevoked: () => "This certificate was already revoked.",
  CallerLacksValidRole: ([role]) => `You need the ${roleName(role)} role to do this.`,
  CallerLacksRole: ([role]) => `You need the ${roleName(role)} role to do this.`,
  AccessControlUnauthorizedAccount: ([, role]) => `You need the ${roleName(role)} role to do this.`,
  RecipientLacksUserRole: ([a]) =>
    `${short(a)} has a Digital ID but not the User role yet, so they can't hold assets. They need to complete onboarding (or an admin must give them the User role).`,
  AssetFrozen: ([tokenId]) => `Asset #${tokenId} is frozen by an admin and cannot be moved right now.`,
  DuplicateContent: ([, tokenId]) =>
    `This exact content already exists as asset #${tokenId}. The same thing cannot be registered twice.`,
  NotOwnerNorAdmin: () => "Only the asset's owner or an admin can do this.",
  ERC721InsufficientApproval: () => "You don't own this asset, so you can't move it.",
  ERC721NonexistentToken: ([tokenId]) => `Asset #${tokenId} doesn't exist, or has been retired.`,
  ERC721InvalidReceiver: () => "That address cannot receive assets.",
  ERC721IncorrectOwner: () => "That account is not the current owner of this asset.",
  InvalidLevel: () => "Choose View, Edit or Manage.",
  GranteeIsOwner: () => "The owner already has full access. There's no need to share with them.",
  NotAuthorizedToGrant: ([, tokenId, level]) =>
    Number(level) === 3
      ? `Only the owner of asset #${tokenId} or an admin can hand out Manage access.`
      : `Only the owner of asset #${tokenId}, an admin, or someone with Manage access can share it.`,
  NotAuthorizedToRevoke: () => "Only the owner, an admin, or whoever shared this access can take it back.",
  NoActiveGrant: () => "This person doesn't currently have access to take back.",
  NotWriter: () => "Only the system's own contracts can write to the history log.",
  RangeOutOfBounds: () => "That range is outside the history log.",
  AlreadySet: () => "This was already configured and cannot be changed again.",
  ZeroAddress: () => "That address is empty.",
  // Onboarding
  RequestExists: ([, status]) => `There is already an onboarding request for this person (${STATUS_LABEL[Number(status)]}).`,
  WrongStage: ([, expected, actual]) =>
    `This request is not at that stage. It is currently: ${STATUS_LABEL[Number(actual)]} (this action needs: ${STATUS_LABEL[Number(expected)]}).`,
  StaffIdTaken: ([staffId, owner]) => `Staff ID ${staffId} already belongs to ${short(owner)}. Each Staff ID can be used once.`,
  EmptyField: ([field]) => `Please fill in the ${field === "staffId" ? "Staff ID" : field}.`,
  NotDepartmentHead: ([, dept]) => `Only the Head of the ${dept} department can approve this request.`,
  SelfApproval: () => "You can't approve your own onboarding request.",
  NotAuthorizedToReject: () => "Only the department head (at stage one) or an admin can reject this request.",
  NotHOD: ([a]) => `${short(a)} doesn't hold the Head of Department role, so they can't head a department.`,
  NotOnboarding: () => "Only the Onboarding contract can grant the User role this way.",
};

function findRevertData(err) {
  const candidates = [err?.data, err?.revert?.data, err?.info?.error?.data, err?.error?.data, err?.error?.error?.data];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) return c;
    if (c && typeof c === "object" && typeof c.data === "string") return c.data;
  }
  return null;
}

/**
 * Turn any thrown error into `{ friendly, technical }`.
 * `friendly` is a sentence for the person using the app; `technical` is the
 * exact contract error, kept for developers and judges.
 */
export function describeError(err) {
  if (err?.code === "ACTION_REJECTED" || err?.code === 4001) {
    return { friendly: "You cancelled this in your wallet.", technical: null };
  }

  let name = null;
  let args = [];
  const data = findRevertData(err);
  if (data) {
    try {
      const parsed = errorIface.parseError(data);
      if (parsed) {
        name = parsed.name;
        args = parsed.args;
      }
    } catch {
      /* not one of ours */
    }
  }
  if (!name && err?.revert?.name) {
    name = err.revert.name;
    args = err.revert.args ?? [];
  }

  if (name) {
    const technical = `${name}(${Array.from(args).map(String).join(", ")})`;
    const friendly = FRIENDLY[name] ? FRIENDLY[name](Array.from(args)) : `The system refused this action (${name}).`;
    return { friendly, technical };
  }

  const raw = err?.shortMessage || err?.reason || err?.message || String(err);
  if (/could not detect network|failed to fetch|ECONNREFUSED/i.test(raw)) {
    return { friendly: "Can't reach the blockchain. Is the local node running?", technical: raw };
  }
  return { friendly: "Something went wrong.", technical: raw };
}

/** Backwards-compatible one-liner. */
export function explainError(err) {
  const { friendly, technical } = describeError(err);
  return technical ? `${friendly} (${technical})` : friendly;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const fmtTime = (n) => (n && Number(n) > 0 ? new Date(Number(n) * 1000).toLocaleString() : "—");
export const toUnix = (datetimeLocal) => (datetimeLocal ? Math.floor(new Date(datetimeLocal).getTime() / 1000) : 0);
export const hashText = (text) => id(text);
export const isZero = (a) => !a || /^0x0{40}$/i.test(a);
