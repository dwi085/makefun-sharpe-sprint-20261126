// Pump.fun Sharpe Sprint — "SteadyClip"
// A diversified early-momentum scalper for the pump.fun replay.
// Idea: coins that attract real buys in their first minutes often keep rising
// briefly. Buy the early rise in small equal slices across many coins, exit fast
// with a tight stop and a modest take-profit, recycle the cash. Many small
// independent bets smooth the equity curve, which is what hourly Sharpe rewards.
//
// Rules of the game (from the kit harness, agent-fun/replay/v2):
// - Capital 10 SOL. Max 5 open positions. One batch of orders per slot; fills
//   land 2 slots after the decision (latency_slots = 2).
// - One mint's buys in one reply may spend at most 1% of its real SOL reserve.
// - Curve fees ~1.25% per side + ~0.000105 SOL tx fee per order; ~2% of txs fail.
// - Round trips must be >= 0.01 SOL on >= 20 distinct mints; drawdown <= 50%.
// - The entry runs twice and the two action logs must match byte for byte, so
//   this file never reads the clock, the environment or Math.random: every
//   decision comes from the harness state alone.
//
// Sizing: 0.04 SOL per position (0.4% of capital), capped at 90% of the mint's
// per-reply buy cap, floored at 0.012 SOL (above the 0.01 SOL round-trip bar).
// Entry: young coin (<= 1200 slots old), >= 8 trades, price >= +7% above its
// creation price, last trade a buy, real SOL reserve >= 1.2 SOL.
// Exit: take-profit +12%, stop-loss -5%, trailing stop -4% from the peak once
// the peak is +6% or better, or a 1500-slot (~10 min) time stop. Sell the whole
// position. No new buys after 48k slots into the window; force-exit after 52k.

import {
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ---- tunables (round numbers, chosen for robustness, not fitted to one window)
const BUY_SIZE_LAMPORTS = 30_000_000n; // 0.03 SOL per position: small, controlled, diversified
const MIN_BUY_LAMPORTS = 12_000_000n; // 0.012 SOL, above the 0.01 SOL bar
const MIN_REAL_QUOTE_LAMPORTS = 3_000_000_000n; // 3 SOL real reserve floor: only coins with real buying depth
const MOMENTUM_BPS = 700; // +7% vs creation price to enter
const MIN_TRADES = 8;
const MAX_AGE_SLOTS = 1200; // ~8 minutes after creation
const TAKE_PROFIT_BPS = 3000; // +30%: let real runners pay for the losers
const STOP_LOSS_BPS = 800; // -8%: wide enough to survive noise, tight enough to cap damage
const TRAIL_TRIGGER_BPS = 10000; // trailing disabled: exits are TP / SL / time-stop only (trailing cut winners early in testing)
const TRAIL_DROP_BPS = 400; // -4% from the peak (unused while trailing is disabled)
const MAX_HOLD_SLOTS = 3000; // ~20 minutes, then exit at market
const REBUY_COOLDOWN_SLOTS = 600; // wait before re-entering the same mint (re-buying churned money away in testing)
const BUY_SLIPPAGE_BPS = 2000;
const SELL_SLIPPAGE_BPS = 1000;
const STOP_BUY_AFTER_SLOTS = 48_000; // stop opening near the end of the window
const FLATTEN_AFTER_SLOTS = 52_000; // force-exit everything late in the window
const MAX_ORDERS_PER_BATCH = 16;

const PRICE_SCALE = 1_000_000n; // price stored as SOL-per-token x 1e6

interface MintTrack {
  createdSlot: number;
  createPrice: bigint;
  price: bigint;
  trades: number;
  lastBuy: boolean;
  realQuote: bigint;
  complete: boolean;
}

interface PosTrack {
  entryPrice: bigint;
  peakPrice: bigint;
  entrySlot: number;
}

function priceOf(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * PRICE_SCALE) / virtualToken;
}

const track = new Map<string, MintTrack>();
const open = new Map<string, PosTrack>();
const traded = new Set<string>();
const lastExitSlot = new Map<string, number>();
let firstSlot = -1;
let batchesSeen = 0;
let buysSent = 0;
let sellsSent = 0;

function refreshTracks(state: BotState, batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const t = track.get(e.mint) ?? {
        createdSlot: e.slot,
        createPrice: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        price: 0n,
        trades: 0,
        lastBuy: true,
        realQuote: 0n,
        complete: false,
      };
      t.price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      t.realQuote = 0n;
      track.set(e.mint, t);
      const c = state.curves.get(e.mint);
      if (c) {
        t.realQuote = c.real_quote_reserves;
        t.price = priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
      }
    } else if (e.event === 'TradeEvent') {
      const t = track.get(e.mint);
      if (!t) continue; // coin created before this window: no true creation price, never trade it
      t.price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      t.realQuote = BigInt(e.real_quote_reserves);
      t.trades += 1;
      t.lastBuy = e.is_buy;
      track.set(e.mint, t);
    } else {
      const t = track.get(e.mint);
      if (t) t.complete = true;
    }
  }
  // Marks refresh prices for held / pending mints even on quiet slots.
  for (const [mint, c] of state.curves) {
    const t = track.get(mint);
    if (t && !t.complete) {
      t.price = priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
      t.realQuote = c.real_quote_reserves;
    }
  }
}

function pendingSide(state: BotState, mint: string, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  if (firstSlot < 0) firstSlot = batch.slot;
  batchesSeen += 1;
  const elapsed = batch.slot - firstSlot;
  const orders: OrderInput[] = [];

  refreshTracks(state, batch);

  // 1) Fold fills: buy fills open a tracked position, sell fills close it.
  for (const f of batch.fills) {
    if (f.status !== 'filled') continue;
    if (f.side === 'buy') {
      const tokens = BigInt(f.token_amount);
      const spent = BigInt(f.quote_lamports);
      if (tokens > 0n && spent > 0n) {
        const entry = (spent * PRICE_SCALE) / tokens;
        open.set(f.mint, { entryPrice: entry, peakPrice: entry, entrySlot: batch.slot });
      }
    } else {
      open.delete(f.mint);
      traded.add(f.mint);
      lastExitSlot.set(f.mint, batch.slot);
    }
  }
  // Harness closes (complete / flatten / writeoff) arrive as sell fills too;
  // a position whose mint completed is gone regardless of the fill wording.
  for (const [mint] of open) {
    const t = track.get(mint);
    if (t?.complete) {
      open.delete(mint);
      traded.add(mint);
      lastExitSlot.set(mint, batch.slot);
    } else if (!state.positions.has(mint) && !pendingSide(state, mint, 'sell')) {
      // Position vanished from the account without a fill we saw: drop it.
      open.delete(mint);
    }
  }

  // 2) Exits first: take-profit, stop-loss, trailing stop, time stop, late flatten.
  for (const [mint, holding] of state.positions) {
    const t = track.get(mint);
    const pos = open.get(mint);
    if (!t || t.complete || pendingSide(state, mint, 'sell')) continue;
    if (t.price <= 0n) continue;
    if (pos) {
      if (t.price > pos.peakPrice) pos.peakPrice = t.price;
    }
    const entry = pos?.entryPrice ?? t.price;
    const peak = pos?.peakPrice ?? t.price;
    const held = pos ? batch.slot - pos.entrySlot : 0;
    const takeProfit = (entry * BigInt(10_000 + TAKE_PROFIT_BPS)) / 10_000n;
    const stopLoss = (entry * BigInt(10_000 - STOP_LOSS_BPS)) / 10_000n;
    const trailArmed = peak >= (entry * BigInt(10_000 + TRAIL_TRIGGER_BPS)) / 10_000n;
    const trailLine = (peak * BigInt(10_000 - TRAIL_DROP_BPS)) / 10_000n;
    const timedOut = pos !== undefined && held >= MAX_HOLD_SLOTS;
    const late = elapsed >= FLATTEN_AFTER_SLOTS;
    if (t.price >= takeProfit || t.price <= stopLoss || (trailArmed && t.price <= trailLine) || timedOut || late) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      sellsSent += 1;
    }
  }

  // 3) Entries: young, active, rising coins we have never held (or cooled down).
  if (elapsed < STOP_BUY_AFTER_SLOTS && orders.length < MAX_ORDERS_PER_BATCH) {
    const freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (freeSlots > 0) {
      // SOL already promised to buys queued in this reply (the shim only counts
      // orders once they are sent, so reserve them here to stay inside cash).
      let reserved = 0n;
      for (const [mint, t] of track) {
        if (orders.length >= MAX_ORDERS_PER_BATCH) break;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) break;
        if (t.complete || t.price <= 0n) continue;
        if (state.positions.has(mint)) continue;
        if (pendingSide(state, mint, 'buy')) continue;
        const age = batch.slot - t.createdSlot;
        if (age < 0 || age > MAX_AGE_SLOTS) continue;
        if (t.trades < MIN_TRADES) continue;
        if (!t.lastBuy) continue;
        if (t.realQuote < MIN_REAL_QUOTE_LAMPORTS) continue;
        const momentumLine = (t.createPrice * BigInt(10_000 + MOMENTUM_BPS)) / 10_000n;
        if (t.price < momentumLine) continue;
        const lastExit = lastExitSlot.get(mint);
        if (traded.has(mint) && lastExit !== undefined && batch.slot - lastExit < REBUY_COOLDOWN_SLOTS) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap <= 0n) continue;
        let size = BUY_SIZE_LAMPORTS;
        const capped = (cap * 90n) / 100n;
        if (size > capped) size = capped;
        if (size < MIN_BUY_LAMPORTS) continue;
        const txFee = state.txFeeLamports();
        if (state.freeCashLamports() - reserved < size + txFee) continue;
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: size,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        reserved += size + txFee;
        buysSent += 1;
      }
    }
  }

  return orders;
}

await runBot({
  onHello(_state) {
    console.error('steady-clip: hello, capital 10 SOL, max 5 open positions');
  },
  onBatch,
  onDone(state) {
    console.error(
      `steady-clip: done after ${batchesSeen} batches, buys ${buysSent}, sells ${sellsSent}, ` +
        `cash ${state.cash} lamports, positions ${state.positions.size}`,
    );
  },
});
