/**
 * Populates a local deployment with demo data so the dApp has something to show.
 * Uses Hardhat's built-in unlocked accounts — run against `npx hardhat node`.
 *
 *   npx hardhat run scripts/seed.js --network localhost
 *
 * Cast (Hardhat default accounts, in order):
 *   #0 admin    #1 issuer    #2 auditor    #3 alice    #4 bob    #5 carol
 */
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const ROLES = {
  ADMIN: ethers.id("ADMIN_ROLE"),
  ISSUER: ethers.id("ISSUER_ROLE"),
  AUDITOR: ethers.id("AUDITOR_ROLE"),
  USER: ethers.id("USER_ROLE"),
};
const LEVEL = { VIEW: 1, EDIT: 2, MANAGE: 3 };

async function main() {
  const file = path.join("deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment found for ${network.name}. Run scripts/deploy.js first.`);
  }
  const { contracts } = JSON.parse(fs.readFileSync(file, "utf8"));

  const [admin, issuer, auditor, alice, bob, carol] = await ethers.getSigners();
  const did = await ethers.getContractAt("DIDRegistry", contracts.DIDRegistry);
  const roles = await ethers.getContractAt("RoleManager", contracts.RoleManager);
  const nft = await ethers.getContractAt("AssetNFT", contracts.AssetNFT);
  const policy = await ethers.getContractAt("AccessPolicy", contracts.AccessPolicy);
  const audit = await ethers.getContractAt("AuditTrail", contracts.AuditTrail);

  console.log("\nIdentities");
  const cast = [
    [issuer, "issuer"], [auditor, "auditor"], [alice, "alice"], [bob, "bob"], [carol, "carol"],
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
    [ROLES.ISSUER, issuer, "issuer  → ISSUER"],
    [ROLES.AUDITOR, auditor, "auditor → AUDITOR"],
    [ROLES.USER, alice, "alice   → USER"],
    [ROLES.USER, bob, "bob     → USER"],
    [ROLES.USER, carol, "carol   → USER"],
  ];
  for (const [role, signer, label] of grants) {
    if (await roles.hasValidRole(role, signer.address)) {
      console.log(`  = ${label} (already)`);
      continue;
    }
    await (await roles.connect(admin).grantRole(role, signer.address)).wait();
    console.log(`  + ${label}`);
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

  console.log("\nPermissions");
  const oneWeek = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
  const perms = [
    [alice, tokenIds[0], bob, LEVEL.VIEW, 0n, "alice grants bob VIEW on #" + tokenIds[0]],
    [alice, tokenIds[0], carol, LEVEL.EDIT, oneWeek, "alice grants carol EDIT on #" + tokenIds[0] + " (7 days)"],
    [alice, tokenIds[1], bob, LEVEL.MANAGE, 0n, "alice grants bob MANAGE on #" + tokenIds[1]],
    [bob, tokenIds[2], alice, LEVEL.VIEW, 0n, "bob grants alice VIEW on #" + tokenIds[2]],
  ];
  for (const [grantor, tokenId, grantee, level, expiresAt, label] of perms) {
    if ((await policy.effectiveLevel(tokenId, grantee.address)) >= BigInt(level)) {
      console.log(`  = ${label} (already)`);
      continue;
    }
    await (await policy.connect(grantor).grantAccess(tokenId, grantee.address, level, expiresAt)).wait();
    console.log(`  + ${label}`);
  }

  console.log("\nCredentials");
  if ((await did.credentialsOf(alice.address)).length === 0) {
    await (await did.connect(issuer).issueCredential(
      alice.address, ethers.id("EMPLOYEE_VERIFIED"), ethers.id("hr-record-alice"), 0
    )).wait();
    console.log("  + issuer certified alice as EMPLOYEE_VERIFIED");
  } else {
    console.log("  = alice already holds a credential");
  }

  const total = await audit.totalEntries();
  const [ok] = await audit.verifyChain(0, total - 1n);
  console.log(`\nAudit trail: ${total} entries, chain ${ok ? "intact ✓" : "BROKEN ✗"}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
