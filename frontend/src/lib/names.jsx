import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * Resolves addresses to the human-readable reference recorded by the
 * Onboarding contract ("Dave Kumar · STAFF-1042"). Results are cached per
 * address and the cache is dropped whenever the app refreshes after a
 * transaction, so a freshly submitted profile shows up immediately.
 */
const NamesContext = createContext({ resolve: () => null });

export function NamesProvider({ contracts, refreshKey, children }) {
  const [names, setNames] = useState({});
  const inflight = useRef(new Set());

  useEffect(() => {
    setNames({});
    inflight.current.clear();
  }, [contracts, refreshKey]);

  const resolve = useCallback(
    (address) => {
      if (!address || !contracts?.onboarding || /^0x0{40}$/i.test(address)) return null;
      const key = address.toLowerCase();
      if (key in names) return names[key];

      if (!inflight.current.has(key)) {
        inflight.current.add(key);
        contracts.onboarding
          .profileOf(address)
          .then((p) => {
            let label = null;
            if (p.staffId) {
              label = p.displayName ? `${p.displayName} · ${p.staffId}` : p.staffId;
              if (!p.approved) label += " (pending)";
            }
            setNames((n) => ({ ...n, [key]: label }));
          })
          .catch(() => setNames((n) => ({ ...n, [key]: null })))
          .finally(() => inflight.current.delete(key));
      }
      return null;
    },
    [contracts, names]
  );

  const value = useMemo(() => ({ resolve }), [resolve]);
  return <NamesContext.Provider value={value}>{children}</NamesContext.Provider>;
}

export const useNames = () => useContext(NamesContext);
