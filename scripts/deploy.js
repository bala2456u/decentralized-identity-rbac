/**
 * Deploys and wires the full system:
 *
 *   DIDRegistry ──► RoleManager ──► AssetNFT ──► AccessPolicy
 *        ▲               │             │              │
 *        └──── roleManager (one-time)  └──── AuditTrail (writers) ──┘
 *
 * Writes `deployments/<network>.json` and exports ABIs + addresses to
 * `frontend/src/` so the dApp picks them up automatically.
 *
 *   npx hardhat run scripts/deploy.js --network localhost
 *   npx hardhat run scripts/deploy.js --network sepolia
 */
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network, artifacts } = require("hardhat");

const CONTRACTS = ["DIDRegistry", "RoleManager", "AuditTrail", "AssetNFT", "AccessPolicy", "Onboarding", "DocumentStore"];

async function send(label, promise) {
  const tx = await promise;
  const receipt = await tx.wait();
  console.log(`  ✓ ${label}  (tx ${receipt.hash.slice(0, 10)}…)`);
  return receipt;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();

  console.log(`\nNetwork : ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance : ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  console.log("Deploying…");
  const did = await (await ethers.getContractFactory("DIDRegistry")).deploy(deployer.address);
  await did.waitForDeployment();
  console.log(`  DIDRegistry   ${await did.getAddress()}`);

  // RoleManager will refuse to deploy until the admin holds an identity.
  if (!(await did.isVerified(deployer.address))) {
    await send(
      "deployer registered a DID",
      did.register("ipfs://deployer-did-document", ethers.id(`did-doc:${deployer.address}`))
    );
    console.log(`    → ${await did.didOf(deployer.address)}`);
  }

  const roles = await (await ethers.getContractFactory("RoleManager")).deploy(deployer.address, await did.getAddress());
  await roles.waitForDeployment();
  console.log(`  RoleManager   ${await roles.getAddress()}`);

  const audit = await (await ethers.getContractFactory("AuditTrail")).deploy(deployer.address);
  await audit.waitForDeployment();
  console.log(`  AuditTrail    ${await audit.getAddress()}`);

  const nft = await (await ethers.getContractFactory("AssetNFT")).deploy(await did.getAddress(), await roles.getAddress());
  await nft.waitForDeployment();
  console.log(`  AssetNFT      ${await nft.getAddress()}`);

  const policy = await (await ethers.getContractFactory("AccessPolicy")).deploy(
    await did.getAddress(),
    await roles.getAddress(),
    await nft.getAddress()
  );
  await policy.waitForDeployment();
  console.log(`  AccessPolicy  ${await policy.getAddress()}`);

  const onboarding = await (await ethers.getContractFactory("Onboarding")).deploy(
    await did.getAddress(),
    await roles.getAddress()
  );
  await onboarding.waitForDeployment();
  console.log(`  Onboarding    ${await onboarding.getAddress()}`);

  const docs = await (await ethers.getContractFactory("DocumentStore")).deploy();
  await docs.waitForDeployment();
  console.log(`  DocumentStore ${await docs.getAddress()}\n`);

  console.log("Wiring…");
  await send("DIDRegistry.setRoleManager", did.setRoleManager(await roles.getAddress()));
  await send("RoleManager.setOnboarding", roles.setOnboarding(await onboarding.getAddress()));
  for (const [name, c] of [
    ["DIDRegistry", did], ["RoleManager", roles], ["AssetNFT", nft], ["AccessPolicy", policy], ["Onboarding", onboarding],
  ]) {
    await send(`AuditTrail.setWriter(${name})`, audit.setWriter(await c.getAddress(), true));
    await send(`${name}.setAuditTrail`, c.setAuditTrail(await audit.getAddress()));
  }

  const record = {
    network: network.name,
    chainId: Number(chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      DIDRegistry: await did.getAddress(),
      RoleManager: await roles.getAddress(),
      AuditTrail: await audit.getAddress(),
      AssetNFT: await nft.getAddress(),
      AccessPolicy: await policy.getAddress(),
      Onboarding: await onboarding.getAddress(),
      DocumentStore: await docs.getAddress(),
    },
  };

  fs.mkdirSync("deployments", { recursive: true });
  const outFile = path.join("deployments", `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`\nSaved ${outFile}`);

  // Frontend exports
  const feDir = path.join("frontend", "src");
  const abiDir = path.join(feDir, "abi");
  fs.mkdirSync(abiDir, { recursive: true });
  for (const name of CONTRACTS) {
    const artifact = await artifacts.readArtifact(name);
    fs.writeFileSync(path.join(abiDir, `${name}.json`), JSON.stringify(artifact.abi, null, 2));
  }
  const feDeployments = path.join(feDir, "deployments.json");
  const existing = fs.existsSync(feDeployments) ? JSON.parse(fs.readFileSync(feDeployments, "utf8")) : {};
  existing[String(chainId)] = record;
  fs.writeFileSync(feDeployments, JSON.stringify(existing, null, 2));
  console.log(`Exported ABIs and addresses to ${feDir}/\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
