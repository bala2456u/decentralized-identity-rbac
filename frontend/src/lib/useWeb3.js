import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, JsonRpcProvider, Wallet } from "ethers";
import { deployedChainIds, getDeployment, makeContracts } from "./contracts";

const LOCAL_CHAIN_ID = 31337;

/**
 * The local Hardhat node is reached through whatever host the page itself was
 * opened on: 127.0.0.1 on the laptop, or the laptop's Wi-Fi address when a
 * phone opens a shared link / QR code on the same network.
 */
// A page served from a bare IP address (or localhost) is a dev/LAN setup: the node lives on that same host.
const isLocalStyleHost = (h) => /^(localhost|\d{1,3}(\.\d{1,3}){3})$/.test(h);
const LOCAL_HOST = typeof window !== "undefined" && isLocalStyleHost(window.location.hostname) ? window.location.hostname : "127.0.0.1";
const LOCAL_RPC = `http://${LOCAL_HOST}:8545`;

/**
 * Public, key-less RPC endpoints used when there is no wallet, so that
 * read-only pages (Verify, History) work for anyone who opens a link.
 */
const READ_ONLY_RPCS = {
  [LOCAL_CHAIN_ID]: LOCAL_RPC,
  11155111: "https://ethereum-sepolia-rpc.publicnode.com",
  80002: "https://rpc-amoy.polygon.technology",
};

/**
 * Hardhat's default test accounts — PUBLIC, documented keys that `npx hardhat node`
 * prints on every start. They exist so anyone can drive the demo without installing
 * a wallet. They hold nothing of value on any network and are only ever offered
 * when the app is connected to chain 31337.
 */
export const DEV_ACCOUNTS = [
  { label: "admin  — ROOT + ADMIN", key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" },
  { label: "issuer — ISSUER", key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" },
  { label: "auditor — AUDITOR", key: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
  { label: "alice  — USER", key: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" },
  { label: "bob    — USER", key: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" },
  { label: "carol  — USER", key: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" },
  { label: "dave   — new user, no identity yet", key: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e" },
  { label: "hod    — Head of Procurement & Finance", key: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" },
];

/**
 * Wallet + provider state. Prefers an injected wallet (MetaMask etc.); falls
 * back to a read-only connection — the local Hardhat node first, then any
 * public network that has a deployment.
 */
export function useWeb3() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [error, setError] = useState(null);
  const [devIndex, setDevIndex] = useState(-1);

  const hasWallet = typeof window !== "undefined" && Boolean(window.ethereum);

  const useReadOnly = useCallback(async () => {
    const candidates = [LOCAL_CHAIN_ID, ...deployedChainIds().filter((c) => c !== LOCAL_CHAIN_ID)];
    for (const cid of candidates) {
      const url = READ_ONLY_RPCS[cid];
      if (!url) continue;
      const p = new JsonRpcProvider(url, cid, { staticNetwork: true });
      try {
        await p.getBlockNumber();
        setProvider(p);
        setChainId(cid);
        setSigner(null);
        setAccount(null);
        setError(null);
        return;
      } catch {
        p.destroy?.();
      }
    }
    const onLocalStyleHost = isLocalStyleHost(window.location.hostname);
    setError(
      onLocalStyleHost
        ? `No wallet detected and no reachable network (tried the local node at ${LOCAL_RPC}). Start it with "npm run node", then "npm run deploy:local" and "npm run seed:local".`
        : "This published site isn't connected to a public test network yet. Once the contracts are deployed to Sepolia and that deployment is committed, verify links and QR codes here will work for everyone."
    );
  }, []);

  /** Act as one of the local demo accounts (index -1 = back to read-only). Local chain only. */
  const useDevAccount = useCallback(async (index) => {
    const p = new JsonRpcProvider(LOCAL_RPC, LOCAL_CHAIN_ID, { staticNetwork: true });
    try {
      await p.getBlockNumber();
      setProvider(p);
      setChainId(LOCAL_CHAIN_ID);
      if (index < 0) {
        setSigner(null);
        setAccount(null);
        setDevIndex(-1);
        return;
      }
      const wallet = new Wallet(DEV_ACCOUNTS[index].key, p);
      setSigner(wallet);
      setAccount(wallet.address);
      setDevIndex(index);
      setError(null);
    } catch (e) {
      setError("Demo accounts need the local Hardhat node running at " + LOCAL_RPC + ".");
    }
  }, []);

  const connect = useCallback(async () => {
    if (!hasWallet) return useReadOnly();
    try {
      const p = new BrowserProvider(window.ethereum);
      await p.send("eth_requestAccounts", []);
      const s = await p.getSigner();
      const net = await p.getNetwork();
      setProvider(p);
      setSigner(s);
      setAccount(await s.getAddress());
      setChainId(Number(net.chainId));
      setDevIndex(-1);
      setError(null);
    } catch (e) {
      setError(e?.shortMessage || e?.message || String(e));
    }
  }, [hasWallet, useReadOnly]);

  useEffect(() => {
    // Demo shortcut: ?as=<index> opens the app already acting as a demo account (local chain only).
    const as = new URLSearchParams(window.location.search).get("as");
    if (as !== null && DEV_ACCOUNTS[Number(as)]) {
      useDevAccount(Number(as));
      return undefined;
    }
    if (!hasWallet) {
      useReadOnly();
      return undefined;
    }

    // Reconnect silently if the site is already authorised; otherwise stay read-only on the wallet's chain.
    window.ethereum
      .request({ method: "eth_accounts" })
      .then(async (accounts) => {
        if (accounts.length) return connect();
        const p = new BrowserProvider(window.ethereum);
        const net = await p.getNetwork();
        setProvider(p);
        setChainId(Number(net.chainId));
      })
      .catch(() => useReadOnly());

    const onAccounts = (accounts) => (accounts.length ? connect() : window.location.reload());
    const onChain = () => window.location.reload();
    window.ethereum.on?.("accountsChanged", onAccounts);
    window.ethereum.on?.("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccounts);
      window.ethereum.removeListener?.("chainChanged", onChain);
    };
  }, [hasWallet, connect, useReadOnly, useDevAccount]);

  const deployment = useMemo(() => (chainId ? getDeployment(chainId) : null), [chainId]);
  const contracts = useMemo(
    () => (deployment && provider ? makeContracts(signer ?? provider, deployment) : null),
    [deployment, provider, signer]
  );

  return {
    provider, signer, account, chainId, deployment, contracts, connect, hasWallet, error,
    useDevAccount, devIndex, isLocalChain: chainId === LOCAL_CHAIN_ID,
  };
}
