import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, JsonRpcProvider } from "ethers";
import { getDeployment, makeContracts } from "./contracts";

const LOCAL_RPC = "http://127.0.0.1:8545";

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

  const hasWallet = typeof window !== "undefined" && Boolean(window.ethereum);

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

  return { provider, signer, account, chainId, deployment, contracts, connect, hasWallet, error };
}
