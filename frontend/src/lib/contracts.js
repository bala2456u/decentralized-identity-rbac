import { Contract, Interface, ZeroHash, id } from "ethers";

import deployments from "../deployments.json";
import DIDRegistry from "../abi/DIDRegistry.json";
import RoleManager from "../abi/RoleManager.json";
import AuditTrail from "../abi/AuditTrail.json";
import AssetNFT from "../abi/AssetNFT.json";
import AccessPolicy from "../abi/AccessPolicy.json";

export const ABIS = { DIDRegistry, RoleManager, AuditTrail, AssetNFT, AccessPolicy };

export const ROLES = {
  DEFAULT_ADMIN: ZeroHash,
  ADMIN: id("ADMIN_ROLE"),
  ISSUER: id("ISSUER_ROLE"),
  AUDITOR: id("AUDITOR_ROLE"),
  USER: id("USER_ROLE"),
};

export const ROLE_LABEL = {
  [ROLES.DEFAULT_ADMIN]: "ROOT",
  [ROLES.ADMIN]: "ADMIN",
  [ROLES.ISSUER]: "ISSUER",
  [ROLES.AUDITOR]: "AUDITOR",
  [ROLES.USER]: "USER",
};

export const GRANTABLE_ROLES = [
  ["ADMIN", ROLES.ADMIN],
  ["ISSUER", ROLES.ISSUER],
  ["AUDITOR", ROLES.AUDITOR],
  ["USER", ROLES.USER],
];

export const LEVELS = ["NONE", "VIEW", "EDIT", "MANAGE"];

const ACTION_NAMES = [
  "DID_REGISTERED", "DID_UPDATED", "DID_DEACTIVATED", "DID_REACTIVATED", "CONTROLLER_ROTATED",
  "CREDENTIAL_ANCHORED", "CREDENTIAL_REVOKED",
  "ROLE_GRANTED", "ROLE_REVOKED",
  "ASSET_MINTED", "ASSET_TRANSFERRED", "ASSET_FROZEN", "ASSET_UNFROZEN", "ASSET_RETIRED",
  "ACCESS_GRANTED", "ACCESS_REVOKED",
];
export const ACTION_LABEL = Object.fromEntries(ACTION_NAMES.map((n) => [id(n), n]));

export const CHAIN_NAMES = {
  31337: "Hardhat local",
  11155111: "Sepolia",
  80002: "Polygon Amoy",
};

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
  };
}

// One interface holding every custom error from every contract, so a revert
// raised deep inside a nested call (e.g. ERC721NonexistentToken thrown by
// AssetNFT while AccessPolicy is running) still decodes to a readable name.
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

function findRevertData(err) {
  const candidates = [err?.data, err?.revert?.data, err?.info?.error?.data, err?.error?.data, err?.error?.error?.data];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) return c;
    if (c && typeof c === "object" && typeof c.data === "string") return c.data;
  }
  return null;
}

export function explainError(err) {
  if (err?.code === "ACTION_REJECTED" || err?.code === 4001) return "Transaction rejected in wallet.";

  const data = findRevertData(err);
  if (data) {
    try {
      const parsed = errorIface.parseError(data);
      if (parsed) return `${parsed.name}(${parsed.args.map(String).join(", ")})`;
    } catch {
      /* not one of ours */
    }
  }
  if (err?.revert?.name) return `${err.revert.name}(${err.revert.args.map(String).join(", ")})`;
  return err?.shortMessage || err?.reason || err?.message || String(err);
}

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const fmtTime = (n) => (n && Number(n) > 0 ? new Date(Number(n) * 1000).toLocaleString() : "—");
export const toUnix = (datetimeLocal) => (datetimeLocal ? Math.floor(new Date(datetimeLocal).getTime() / 1000) : 0);
export const hashText = (text) => id(text);
