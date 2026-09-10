/**
 * Populates a local deployment with demo data so the dApp has something to show.
 * Uses Hardhat's built-in unlocked accounts — run against `npx hardhat node`.
 *
 *   npx hardhat run scripts/seed.js --network localhost
 *
 * Cast (Hardhat default accounts, in order):
 *   #0 admin   #1 issuer   #2 auditor   #3 alice   #4 bob   #5 carol
 *   #6 dave    (left untouched: the live-demo newcomer)
 *   #7 hod     (Head of the Procurement and Finance departments)
 *
 * alice, bob and carol are onboarded through the real approval workflow:
 * submit → HOD approves → admin approves → USER_ROLE granted by the contract.
 */
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const ROLES = {
  ADMIN: ethers.id("ADMIN_ROLE"),
  ISSUER: ethers.id("ISSUER_ROLE"),
  AUDITOR: ethers.id("AUDITOR_ROLE"),
  HOD: ethers.id("HOD_ROLE"),
  USER: ethers.id("USER_ROLE"),
};
const LEVEL = { VIEW: 1, EDIT: 2, MANAGE: 3 };
const STATUS = { NONE: 0, PENDING_HOD: 1, PENDING_ADMIN: 2, APPROVED: 3, REJECTED: 4 };

async function main() {
  const file = path.join("deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found for ${network.name}. Run scripts/deploy.js first.`);
  }
  const { contracts } = JSON.parse(fs.readFileSync(file, "utf8"));

  const signers = await ethers.getSigners();
  const [admin, issuer, auditor, alice, bob, carol] = signers;
  const hod = signers[7];

  const did = await ethers.getContractAt("DIDRegistry", contracts.DIDRegistry);
  const roles = await ethers.getContractAt("RoleManager", contracts.RoleManager);
  const nft = await ethers.getContractAt("AssetNFT", contracts.AssetNFT);
  const policy = await ethers.getContractAt("AccessPolicy", contracts.AccessPolicy);
  const audit = await ethers.getContractAt("AuditTrail", contracts.AuditTrail);
  const onboarding = await ethers.getContractAt("Onboarding", contracts.Onboarding);

  console.log("\nIdentities");
  const cast = [
    [issuer, "issuer"], [auditor, "auditor"], [alice, "alice"], [bob, "bob"], [carol, "carol"], [hod, "hod"],
  ];
  for (const [signer, name] of cast) {
    if (await did.isVerified(signer.address)) {
      console.log(`  = ${name.padEnd(8)} already registered`);
      continue;
    }
    await (await did.connect(signer).register(`ipfs://did-doc-${name}`, ethers.id(`did-doc:${name}`))).wait();
    console.log(`  + ${name.padEnd(8)} ${await did.didOf(signer.address)}`);
  }

  console.log("\nRoles");
  const grants = [
    [ROLES.ISSUER, issuer, "issuer  → Issuer"],
    [ROLES.AUDITOR, auditor, "auditor → Auditor"],
    [ROLES.HOD, hod, "hod     → Head of Department"],
  ];
  for (const [role, signer, label] of grants) {
    if (await roles.hasValidRole(role, signer.address)) {
      console.log(`  = ${label} (already)`);
      continue;
    }
    await (await roles.connect(admin).grantRole(role, signer.address)).wait();
    console.log(`  + ${label}`);
  }

  console.log("\nDepartment heads");
  for (const dept of ["Procurement", "Finance"]) {
    if ((await onboarding.departmentHead(dept)) === hod.address) {
      console.log(`  = ${dept.padEnd(12)} → hod (already)`);
      continue;
    }
    await (await onboarding.connect(admin).setDepartmentHead(dept, hod.address)).wait();
    console.log(`  + ${dept.padEnd(12)} → hod`);
  }

  console.log("\nStaff profiles (privileged staff, set by admin)");
  const staff = [
    [admin, "STAFF-0001", "Priya Nair", "Administration"],
    [issuer, "STAFF-0002", "Ravi Shankar", "Records Office"],
    [auditor, "STAFF-0003", "Meera Joshi", "Internal Audit"],
    [hod, "STAFF-0010", "Arjun Rao", "Procurement"],
  ];
  for (const [signer, staffId, name, dept] of staff) {
    if ((await onboarding.statusOf(signer.address)) !== BigInt(STATUS.NONE)) {
      console.log(`  = ${staffId} ${name} (already)`);
      continue;
    }
    await (await onboarding.connect(admin).setProfileByAdmin(signer.address, staffId, name, dept)).wait();
    console.log(`  + ${staffId} ${name.padEnd(14)} ${dept}`);
  }

  console.log("\nOnboarding workflow (submit → HOD approves → admin approves)");
  const applicants = [
    [alice, "STAFF-1001", "Alice Fernandes", "Procurement"],
    [bob, "STAFF-1002", "Bob Mehta", "Finance"],
    [carol, "STAFF-1003", "Carol Iyer", "Procurement"],
  ];
  for (const [signer, staffId, name, dept] of applicants) {
    let status = await onboarding.statusOf(signer.address);
    if (status === BigInt(STATUS.NONE) || status === BigInt(STATUS.REJECTED)) {
      await (await onboarding.connect(signer).submit(staffId, name, dept, ethers.id(`onboarding-form:${staffId}`))).wait();
      console.log(`  + ${name.padEnd(16)} submitted as ${staffId} (${dept})`);
      status = BigInt(STATUS.PENDING_HOD);
    }
    if (status === BigInt(STATUS.PENDING_HOD)) {
      await (await onboarding.connect(hod).approveByHOD(signer.address)).wait();
      console.log(`    ✓ approved by Head of ${dept}`);
      status = BigInt(STATUS.PENDING_ADMIN);
    }
    if (status === BigInt(STATUS.PENDING_ADMIN)) {
      await (await onboarding.connect(admin).approveByAdmin(signer.address)).wait();
      console.log(`    ✓ approved by admin → User role granted by the contract`);
    } else {
      console.log(`  = ${name.padEnd(16)} already onboarded`);
    }
  }

  console.log("\nAssets");
  const assets = [
    [alice, "Supplier Contract 2026", "contract", "ipfs://QmSupplierContract2026"],
    [alice, "Product Design Spec v3", "design", "ipfs://QmProductDesignV3"],
    [bob, "Q3 Financial Report", "report", "ipfs://QmQ3FinancialReport"],
  ];
  const tokenIds = [];
  for (const [owner, title, category, uri] of assets) {
    const contentHash = ethers.id(title);
    let tokenId = await nft.tokenByContentHash(contentHash);
    if (tokenId === 0n) {
      const receipt = await (await nft.connect(issuer).mint(owner.address, uri, contentHash, category)).wait();
      const log = receipt.logs.map((l) => { try { return nft.interface.parseLog(l); } catch { return null; } })
        .find((l) => l && l.name === "AssetMinted");
      tokenId = log.args.tokenId;
      console.log(`  + #${tokenId} "${title}" → ${await nft.ownerDID(tokenId)}`);
    } else {
      console.log(`  = #${tokenId} "${title}" (already)`);
    }
    tokenIds.push(tokenId);
  }

  console.log("\nSharing");
  const oneWeek = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
  const perms = [
    [alice, tokenIds[0], bob, LEVEL.VIEW, 0n, "alice shares #" + tokenIds[0] + " with bob (View)"],
    [alice, tokenIds[0], carol, LEVEL.EDIT, oneWeek, "alice shares #" + tokenIds[0] + " with carol (Edit, 7 days)"],
    [alice, tokenIds[1], bob, LEVEL.MANAGE, 0n, "alice shares #" + tokenIds[1] + " with bob (Manage)"],
    [bob, tokenIds[2], alice, LEVEL.VIEW, 0n, "bob shares #" + tokenIds[2] + " with alice (View)"],
  ];
  for (const [grantor, tokenId, grantee, level, expiresAt, label] of perms) {
    if ((await policy.effectiveLevel(tokenId, grantee.address)) >= BigInt(level)) {
      console.log(`  = ${label} (already)`);
      continue;
    }
    await (await policy.connect(grantor).grantAccess(tokenId, grantee.address, level, expiresAt)).wait();
    console.log(`  + ${label}`);
  }

  console.log("\nCertificates");
  if ((await did.credentialsOf(alice.address)).length === 0) {
    await (await did.connect(issuer).issueCredential(
      alice.address, ethers.id("EMPLOYEE_VERIFIED"), ethers.id("hr-record-alice"), 0
    )).wait();
    console.log("  + issuer certified alice as EMPLOYEE_VERIFIED");
  } else {
    console.log("  = alice already holds a certificate");
  }

  const total = await audit.totalEntries();
  const [ok] = await audit.verifyChain(0, total - 1n);
  console.log(`\nHistory: ${total} entries, chain ${ok ? "intact ✓" : "BROKEN ✗"}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
