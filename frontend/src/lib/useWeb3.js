import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, JsonRpcProvider, Wallet } from "ethers";
import { getDeployment, makeContracts } from "./contracts";

const LOCAL_RPC = "http://127.0.0.1:8545";
const LOCAL_CHAIN_ID = 31337;

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
];

/**
 * Wallet + provider state. Prefers an injected wallet (MetaMask etc.); falls
 * back to a read-only connection to a local Hardhat node when none is present.
 */
export function useWeb3() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [error, setError] = useState(null);
  const [devIndex, setDevIndex] = useState(-1);

  const hasWallet = typeof window !== "undefined" && Boolean(window.ethereum);

  /** Act as one of the local demo accounts (index -1 = back to read-only). Local chain only. */
  const useDevAccount = useCallback(async (index) => {
    const p = new JsonRpcProvider(LOCAL_RPC);
    try {
      const net = await p.getNetwork();
      if (Number(net.chainId) !== LOCAL_CHAIN_ID) throw new Error("Demo accounts only work on the local Hardhat chain.");
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
      setError(e?.shortMessage || e?.message || String(e));
    }
  }, []);

  const useReadOnly = useCallback(async () => {
    const p = new JsonRpcProvider(LOCAL_RPC);
    try {
      const net = await p.getNetwork();
      setProvider(p);
      setChainId(Number(net.chainId));
      setSigner(null);
      setAccount(null);
    } catch {
      setError(`No wallet detected and no local node reachable at ${LOCAL_RPC}.`);
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
      setError(null);
    } catch (e) {
      setError(e?.shortMessage || e?.message || String(e));
    }
  }, [hasWallet, useReadOnly]);

  useEffect(() => {
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
      .catch(() => {});

    const onAccounts = (accounts) => (accounts.length ? connect() : window.location.reload());
    const onChain = () => window.location.reload();
    window.ethereum.on?.("accountsChanged", onAccounts);
    window.ethereum.on?.("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccounts);
      window.ethereum.removeListener?.("chainChanged", onChain);
    };
  }, [hasWallet, connect, useReadOnly]);

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
