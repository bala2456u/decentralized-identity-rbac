require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const {
  PRIVATE_KEY,
  SEPOLIA_RPC_URL,
  AMOY_RPC_URL,
  ETHERSCAN_API_KEY,
  POLYGONSCAN_API_KEY,
} = process.env;

// Accept the key with or without the 0x prefix; never hard-fail when it's absent
// so that compile/test keep working on a machine with no .env at all.
const accounts = PRIVATE_KEY
  ? [PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`]
  : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun", // OpenZeppelin 5.x uses mcopy
    },
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    sepolia: { url: SEPOLIA_RPC_URL || "", accounts, chainId: 11155111 },
    amoy: { url: AMOY_RPC_URL || "", accounts, chainId: 80002 },
  },
  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_API_KEY || "",
      polygonAmoy: POLYGONSCAN_API_KEY || "",
    },
  },
  gasReporter: { enabled: false },
  mocha: { timeout: 60000 },
};
