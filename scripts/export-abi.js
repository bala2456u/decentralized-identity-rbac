/**
 * Copies the compiled ABIs into frontend/src/abi/ so the dApp can be built
 * straight from a clone. Also called by deploy.js after every deployment.
 *
 *   npx hardhat run scripts/export-abi.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { artifacts } = require("hardhat");

const CONTRACTS = ["DIDRegistry", "RoleManager", "AuditTrail", "AssetNFT", "AccessPolicy", "Onboarding"];

async function exportAbis() {
  const feDir = path.join("frontend", "src");
  const abiDir = path.join(feDir, "abi");
  fs.mkdirSync(abiDir, { recursive: true });

  for (const name of CONTRACTS) {
    const artifact = await artifacts.readArtifact(name);
    fs.writeFileSync(path.join(abiDir, `${name}.json`), JSON.stringify(artifact.abi, null, 2));
  }

  const deploymentsFile = path.join(feDir, "deployments.json");
  if (!fs.existsSync(deploymentsFile)) {
    fs.writeFileSync(deploymentsFile, "{}\n");
  }
  return abiDir;
}

module.exports = { exportAbis, CONTRACTS };

if (require.main === module) {
  exportAbis()
    .then((dir) => console.log(`Exported ${CONTRACTS.length} ABIs to ${dir}/`))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
