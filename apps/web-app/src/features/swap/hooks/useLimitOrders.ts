"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type {
  LimitOrder,
  LimitOrderSide,
  LimitOrderExpiry,
  LimitOrderStorageSchema,
} from "../types/limitOrder";
import { EXPIRY_MS } from "../types/limitOrder";
import { LIMIT_ORDER_STORAGE_VERSION } from "../constants/swapConfig";
import type { Token } from "@/lib/helpers/stellar/soroswap";
import { DEFAULT_SLIPPAGE_BPS } from "../constants/swapConfig";

// ─── Storage helpers ──────────────────────────────────────────────────────────

function storageKey(walletAddress: string): string {
  return `neko_limit_orders_v${LIMIT_ORDER_STORAGE_VERSION}_${walletAddress}`;
}

function loadFromStorage(walletAddress: string): LimitOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(storageKey(walletAddress));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LimitOrderStorageSchema;
    if (parsed.version !== LIMIT_ORDER_STORAGE_VERSION) return [];
    return parsed.orders ?? [];
  } catch {
    return [];
  }
}

function saveToStorage(walletAddress: string, orders: LimitOrder[]): void {
  if (typeof window === "undefined") return;
  try {
    const schema: LimitOrderStorageSchema = {
      version: LIMIT_ORDER_STORAGE_VERSION,
      orders,
    };
    localStorage.setItem(storageKey(walletAddress), JSON.stringify(schema));
  } catch {
    // Storage quota exceeded or unavailable — fail silently.
  }
}

// ─── Hook public API ──────────────────────────────────────────────────────────

export interface AddLimitOrderParams {
  walletAddress: string;
  tokenIn: Token | string;
  tokenOut: Token | string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountIn: string;
  limitPrice: string;
  side: LimitOrderSide;
  expiry: LimitOrderExpiry;
  slippageBps?: number;
}

export interface ConfirmationResult {
  /** The order after the update, or null if it was not found. */
  order: LimitOrder | null;
  /** The new consecutive confirmation count. */
  consecutiveConfirmations: number;
  /** True only on the transition into `ready` (fires exactly once). */
  becameReady: boolean;
}

export interface UseLimitOrdersReturn {
  orders: LimitOrder[];
  addOrder: (params: AddLimitOrderParams) => LimitOrder;
  cancelOrder: (id: string) => void;
  markFilled: (id: string) => void;
  markExpired: (id: string) => void;
  markReady: (id: string) => void;
  incrementConfirmation: (id: string, threshold: number) => ConfirmationResult;
  resetConfirmation: (id: string) => ConfirmationResult;
  clearOrders: () => void;
}

/**
 * Manages the in-memory list of limit orders for the connected wallet.
 * Persists to localStorage on every mutation.
 * Call `clearOrders()` on wallet disconnect.
 */
export function useLimitOrders(
  walletAddress: string | undefined
): UseLimitOrdersReturn {
  const [orders, setOrders] = useState<LimitOrder[]>(() => {
    if (!walletAddress) return [];
    return loadFromStorage(walletAddress);
  });

  // Mirror of the latest orders for synchronous reads (e.g. returning a
  // freshly-mutated order from an action). Kept in sync inside the setState
  // updater so it is never stale relative to committed state.
  const ordersRef = useRef<LimitOrder[]>(orders);
  ordersRef.current = orders;

  // Re-hydrate when wallet address changes (connect / switch).
  useEffect(() => {
    if (!walletAddress) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- re-hydrating from localStorage when walletAddress changes, an external-system sync, not derived state
      setOrders([]);
      return;
    }
    setOrders(loadFromStorage(walletAddress));
  }, [walletAddress]);

  // Persist to localStorage whenever orders change.
  useEffect(() => {
    if (!walletAddress) return;
    saveToStorage(walletAddress, orders);
  }, [walletAddress, orders]);

  // Keep the synchronous mirror in sync with committed state.
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const mutate = useCallback(
    (updater: (prev: LimitOrder[]) => LimitOrder[]) => {
      setOrders((prev) => updater(prev));
    },
    []
  );

  // ── Public Actions ────────────────────────────────────────────────────────

  const addOrder = useCallback(
    (params: AddLimitOrderParams): LimitOrder => {
      const expiryMs = EXPIRY_MS[params.expiry];
      const now = Date.now();
      const order: LimitOrder = {
        id: crypto.randomUUID(),
        walletAddress: params.walletAddress,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        tokenInSymbol: params.tokenInSymbol,
        tokenOutSymbol: params.tokenOutSymbol,
        amountIn: params.amountIn,
        limitPrice: params.limitPrice,
        side: params.side,
        slippageBps: params.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
        status: "open",
        createdAt: now,
        expiresAt: expiryMs !== null ? now + expiryMs : null,
        consecutiveConfirmations: 0,
        filledAt: null,
      };
      mutate((prev) => [order, ...prev]);
      return order;
    },
    [mutate]
  );

  const cancelOrder = useCallback(
    (id: string) => {
      mutate((prev) =>
        prev.map((o) => (o.id === id ? { ...o, status: "cancelled" } : o))
      );
    },
    [mutate]
  );

  const markFilled = useCallback(
    (id: string) => {
      mutate((prev) =>
        prev.map((o) =>
          o.id === id ? { ...o, status: "filled", filledAt: Date.now() } : o
        )
      );
    },
    [mutate]
  );

  const markExpired = useCallback(
    (id: string) => {
      mutate((prev) =>
        prev.map((o) => (o.id === id ? { ...o, status: "expired" } : o))
      );
    },
    [mutate]
  );

  const markReady = useCallback(
    (id: string) => {
      mutate((prev) =>
        prev.map((o) => (o.id === id ? { ...o, status: "ready" } : o))
      );
    },
    [mutate]
  );

  const incrementConfirmation = useCallback(
    (id: string, threshold: number): ConfirmationResult => {
      // Compute the result synchronously from the freshest committed state so
      // the caller never has to infer the new count from a stale ref. The
      // threshold check and the `ready` transition happen atomically inside
      // the setState updater, guaranteeing exactly-once semantics.
      const current = ordersRef.current.find((o) => o.id === id);
      if (!current) {
        return { order: null, consecutiveConfirmations: 0, becameReady: false };
      }

      const nextCount = current.consecutiveConfirmations + 1;
      const becameReady =
        current.status === "open" && nextCount >= threshold;

      let updated: LimitOrder | null = null;
      setOrders((prev) => {
        const idx = prev.findIndex((o) => o.id === id);
        if (idx === -1) return prev;
        const o = prev[idx];
        const count = o.consecutiveConfirmations + 1;
        const ready = o.status === "open" && count >= threshold;
        const next: LimitOrder = {
          ...o,
          consecutiveConfirmations: count,
          status: ready ? "ready" : o.status,
        };
        updated = next;
        const copy = prev.slice();
        copy[idx] = next;
        return copy;
      });

      return {
        order: updated,
        consecutiveConfirmations: nextCount,
        becameReady,
      };
    },
    []
  );

  const resetConfirmation = useCallback(
    (id: string): ConfirmationResult => {
      const current = ordersRef.current.find((o) => o.id === id);
      if (!current) {
        return { order: null, consecutiveConfirmations: 0, becameReady: false };
      }

      let updated: LimitOrder | null = null;
      setOrders((prev) => {
        const idx = prev.findIndex((o) => o.id === id);
        if (idx === -1) return prev;
        const next: LimitOrder = { ...prev[idx], consecutiveConfirmations: 0 };
        updated = next;
        const copy = prev.slice();
        copy[idx] = next;
        return copy;
      });

      return { order: updated, consecutiveConfirmations: 0, becameReady: false };
    },
    []
  );

  const clearOrders = useCallback(() => {
    setOrders([]);
  }, []);

  return {
    orders,
    addOrder,
    cancelOrder,
    markFilled,
    markExpired,
    markReady,
    incrementConfirmation,
    resetConfirmation,
    clearOrders,
  };
}
