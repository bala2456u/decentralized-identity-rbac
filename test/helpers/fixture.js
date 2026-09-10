const { ethers } = require("hardhat");

const ROLES = {
  DEFAULT_ADMIN: ethers.ZeroHash,
  ADMIN: ethers.id("ADMIN_ROLE"),
  ISSUER: ethers.id("ISSUER_ROLE"),
  AUDITOR: ethers.id("AUDITOR_ROLE"),
  HOD: ethers.id("HOD_ROLE"),
  USER: ethers.id("USER_ROLE"),
};

const LEVEL = { NONE: 0, VIEW: 1, EDIT: 2, MANAGE: 3 };

/** Onboarding.Status */
const STATUS = { NONE: 0, PENDING_HOD: 1, PENDING_ADMIN: 2, APPROVED: 3, REJECTED: 4 };

const ACTIONS = Object.fromEntries(
  [
    "DID_REGISTERED",
    "DID_UPDATED",
    "DID_DEACTIVATED",
    "DID_REACTIVATED",
    "CONTROLLER_ROTATED",
    "CREDENTIAL_ANCHORED",
    "CREDENTIAL_REVOKED",
    "ROLE_GRANTED",
    "ROLE_REVOKED",
    "ONBOARDING_SUBMITTED",
    "ONBOARDING_HOD_APPROVED",
    "ONBOARDING_APPROVED",
    "ONBOARDING_REJECTED",
    "PROFILE_SET_BY_ADMIN",
    "DEPARTMENT_HEAD_SET",
    "ASSET_MINTED",
    "ASSET_TRANSFERRED",
    "ASSET_FROZEN",
    "ASSET_UNFROZEN",
    "ASSET_RETIRED",
    "ACCESS_GRANTED",
    "ACCESS_REVOKED",
  ].map((name) => [name, ethers.id(name)])
);

async function registerDID(did, signer, label = "doc") {
  const docHash = ethers.id(`${label}:${signer.address}`);
  await did.connect(signer).register(`ipfs://${label}-${signer.address.slice(2, 8)}`, docHash);
  return docHash;
}

/**
 * Deploys and wires the whole system, then seeds a small cast:
 *   admin    – deployer, DEFAULT_ADMIN + ADMIN
 *   issuer   – ISSUER_ROLE
 *   auditor  – AUDITOR_ROLE (has a DID but NOT USER_ROLE, so cannot hold assets)
 *   alice/bob/carol – USER_ROLE (granted directly by the admin)
 *   mallory  – no DID at all; the adversary in every negative test
 *   hod      – HOD_ROLE, head of the "Procurement" department
 *   dave     – has a DID, no roles, no onboarding request yet
 */
async function deploySystem() {
  const [admin, issuer, auditor, alice, bob, carol, mallory, hod, dave] = await ethers.getSigners();

  const did = await (await ethers.getContractFactory("DIDRegistry")).deploy(admin.address);

  // RoleManager refuses to deploy unless the admin already holds an identity.
  await registerDID(did, admin, "admin");

  const roles = await (await ethers.getContractFactory("RoleManager")).deploy(admin.address, await did.getAddress());
  const audit = await (await ethers.getContractFactory("AuditTrail")).deploy(admin.address);
  const nft = await (await ethers.getContractFactory("AssetNFT")).deploy(
    await did.getAddress(),
    await roles.getAddress()
  );
  const policy = await (await ethers.getContractFactory("AccessPolicy")).deploy(
    await did.getAddress(),
    await roles.getAddress(),
    await nft.getAddress()
  );
  const onboarding = await (await ethers.getContractFactory("Onboarding")).deploy(
    await did.getAddress(),
    await roles.getAddress()
  );
  const docs = await (await ethers.getContractFactory("DocumentStore")).deploy();

  // Wiring
  await did.setRoleManager(await roles.getAddress());
  await roles.setOnboarding(await onboarding.getAddress());
  for (const c of [did, roles, nft, policy, onboarding]) {
    await audit.setWriter(await c.getAddress(), true);
    await c.setAuditTrail(await audit.getAddress());
  }

  // Cast identities (mallory deliberately left out)
  for (const s of [issuer, auditor, alice, bob, carol, hod, dave]) {
    await registerDID(did, s);
  }

  // Roles
  await roles.grantRole(ROLES.ISSUER, issuer.address);
  await roles.grantRole(ROLES.AUDITOR, auditor.address);
  for (const s of [alice, bob, carol]) {
    await roles.grantRole(ROLES.USER, s.address);
  }
  await roles.grantRole(ROLES.HOD, hod.address);
  await onboarding.setDepartmentHead("Procurement", hod.address);

  return { did, roles, audit, nft, policy, onboarding, docs, admin, issuer, auditor, alice, bob, carol, mallory, hod, dave };
}

/** Mint one asset to `to` from the issuer; returns the tokenId. */
async function mintTo(nft, issuer, to, label = "asset") {
  const contentHash = ethers.id(`${label}:${to.address}:${Date.now()}:${Math.random()}`);
  const tx = await nft.connect(issuer).mint(to.address, `ipfs://${label}`, contentHash, "document");
  const receipt = await tx.wait();
  const log = receipt.logs.map((l) => { try { return nft.interface.parseLog(l); } catch { return null; } })
    .find((l) => l && l.name === "AssetMinted");
  return { tokenId: log.args.tokenId, contentHash };
}

async function eip712Domain(name, contract) {
  const { chainId } = await ethers.provider.getNetwork();
  return { name, version: "1", chainId, verifyingContract: await contract.getAddress() };
}

const CREDENTIAL_TYPES = {
  Credential: [
    { name: "issuer", type: "address" },
    { name: "subject", type: "address" },
    { name: "schema", type: "bytes32" },
    { name: "claimHash", type: "bytes32" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};

async function signCredential(did, issuerSigner, { subject, schema, claimHash, expiresAt = 0, nonce }) {
  const domain = await eip712Domain("YHackDIDRegistry", did);
  const value = {
    issuer: issuerSigner.address,
    subject,
    schema,
    claimHash,
    expiresAt,
    nonce: nonce ?? (await did.nonces(issuerSigner.address)),
  };
  const signature = await issuerSigner.signTypedData(domain, CREDENTIAL_TYPES, value);
  return { value, signature };
}

const GRANT_TYPES = {
  AccessGrant: [
    { name: "tokenId", type: "uint256" },
    { name: "grantee", type: "address" },
    { name: "level", type: "uint8" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

async function signGrant(policy, signer, { tokenId, grantee, level, expiresAt = 0, nonce, deadline }) {
  const domain = await eip712Domain("YHackAccessPolicy", policy);
  const req = {
    tokenId,
    grantee,
    level,
    expiresAt,
    nonce: nonce ?? (await policy.nonces(signer.address)),
    deadline: deadline ?? Math.floor(Date.now() / 1000) + 3600,
  };
  const signature = await signer.signTypedData(domain, GRANT_TYPES, req);
  return { req, signature };
}

module.exports = {
  ROLES,
  LEVEL,
  STATUS,
  ACTIONS,
  deploySystem,
  registerDID,
  mintTo,
  signCredential,
  signGrant,
};
