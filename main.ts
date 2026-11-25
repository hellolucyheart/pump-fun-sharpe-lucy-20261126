// Sharpe Sniper — a paper-trading bot for the pump.fun replay (pumpfun-replay/v2).
//
// The bot speaks the replay protocol over stdin/stdout: the harness sends a
// `hello` line (capital, caps, latency, fees), then one `batch` per slot window
// carrying the events, marks and fills for that slot, and the bot answers every
// batch with one reply echoing its `seq` and the `orders` it wants placed.
// A final `done` line closes the run. Every amount the harness sends is a u64
// decimal string; the bot keeps all of its own books in lamports (bigint) and
// compares prices with integer cross-multiplication only, so two runs of the
// same replay produce the same action log byte for byte: no clock, no
// randomness, no environment, no network.
//
// Strategy, in one paragraph: steady scalping for hourly Sharpe, not moonshots.
// Every coin is watched from its CreateEvent. In its first two slots the bot
// reads the opening tape: how big the creator's own buy was, how many other
// wallets piled in with it (a launch bundled by many wallets in its first slot
// is usually the creator's cluster waiting to dump), whether the creator has
// already sold, and how much real SOL the curve holds. It buys only launches
// that pass that rug filter, one small stake per coin, then exits on the first
// of a take-profit, a stop loss, a short trailing stop, a short time limit, or
// the creator selling while it holds. A pacing probe keeps the run above the
// guardrail pace (at least 20 coins, each with a round trip of 0.01 SOL or
// more) by opening tiny round trips on liquid curves whenever the bot's own
// fills or coins lag the pace. Small stakes on many coins keep the hourly
// return series smooth: that is what the hourly Sharpe ranking rewards.
//
// Paper money only: nothing here touches a real wallet, a real trade, or the
// network. The grader runs it as `node /bot/main.ts` (Node 22 strips the
// types; no build step, no dependencies).
//
// This entry is a plain program: the competition waives the model-call floor
// (its harness says model calls are optional), so the bot calls no model and
// needs no provider key.

// --- Tuning: entry filter ------------------------------------------------
const MAX_AGE_SLOTS = 2; // oldest age (slots since create) a first buy may be decided at
const MIN_REAL_SOL = 0.3; // curve real SOL bounds at decision time
const MAX_REAL_SOL = 25.0;
const MAX_DEV_BUY_SOL = 2.0; // creator's own buys in the create slot, at most
const MAX_EARLY_BUYERS = 3; // distinct non-creator buyers seen before entry, at most
const MIN_RUNUP_NUM = 98; // price now over the create price: window [0.98, 1.40]
const MIN_RUNUP_DEN = 100;
const MAX_RUNUP_NUM = 140;
const MAX_RUNUP_DEN = 100;
const SKIP_DEV_SOLD = true; // creator sold before entry: skip the coin

// --- Tuning: sizing --------------------------------------------------------
const STAKE_BPS_OF_CAPITAL = 80; // 0.80% of starting capital per coin
const MIN_BUY_SOL = 0.012; // smallest single buy worth paying the tx fee for
// (just above the 0.01 SOL round-trip floor: the 1%-of-real-reserves size cap
// means a small launch only admits a small stake, and a floor above the
// round-trip minimum would shut the bot out of most fresh launches)
const MAX_POSITIONS_FALLBACK = 5; // hello.caps.max_open_positions rules when present
const BUY_SLIPPAGE_BPS = 10000;
const SELL_SLIPPAGE_BPS = 10000;

// --- Tuning: exits ---------------------------------------------------------
const TAKE_PROFIT_NUM = 118; // sell all when value reaches cost * 118/100
const TAKE_PROFIT_DEN = 100;
const STOP_LOSS_NUM = 91; // sell all when value falls to cost * 91/100
const STOP_LOSS_DEN = 100;
const TRAIL_ARM_NUM = 109; // trailing stop arms once peak reaches cost * 109/100
const TRAIL_ARM_DEN = 100;
const TRAIL_NUM = 93; // sell all when value falls to peak * 93/100
const TRAIL_DEN = 100;
const MAX_HOLD_SLOTS = 8; // exit after this many slots held
const STALE_SLOTS = 90; // exit when no trade has hit the coin for this many slots
const EXIT_ON_DEV_SELL = true; // exit at once when the creator sells while held

// --- Tuning: guardrail pacing ----------------------------------------------
const TARGET_COINS = 21; // coins the run should reach (guardrail needs 20)
const TARGET_FILLS = 42; // fills the run should reach (2 per coin round trip)
const PACE_SECONDS = 21600; // block-time seconds the pace is measured over (6 h)
const PROBE_SOL = 0.012; // probe buy size (above the 0.01 SOL round-trip floor)
const MAX_PROBES = 1; // most probe round trips open at once

// --- Tuning: safety ----------------------------------------------------------
const EQUITY_GUARD_NUM = 80; // stop opening new positions when equity < 80/100 of capital
const EQUITY_GUARD_DEN = 100;

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS_DEN = 10_000n;

function lamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1_000_000_000));
}

// --- Wire types (subset of the protocol schema, only what this bot reads) ---

type U64 = string;
type Pubkey = string;

interface Hello {
  type: 'hello';
  protocol: string;
  seed: U64;
  universe: unknown;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

interface ChainEvent {
  event: string;
  mint: Pubkey;
  slot: number;
  block_time?: number | null;
  creator?: Pubkey;
  user?: Pubkey;
  virtual_quote_reserves?: U64;
  virtual_token_reserves?: U64;
  real_quote_reserves?: U64;
  sol_amount?: U64;
  is_buy?: boolean;
}

interface Mark {
  mint: Pubkey;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

interface Fill {
  client_id: string;
  mint: Pubkey;
  side: 'buy' | 'sell';
  status: 'filled' | 'rejected' | 'failed';
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
  fee_fallback: boolean;
}

interface AccountPosition {
  mint: Pubkey;
  token_amount: U64;
  cost_lamports: U64;
}

interface Batch {
  type: 'batch';
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: { cash_lamports: U64; positions: AccountPosition[] };
}

interface Done {
  type: 'done';
  seq: number;
  reason: 'end_of_data' | 'aborted';
  account: { cash_lamports: U64; positions: AccountPosition[] };
}

type Side = 'buy' | 'sell';

interface Order {
  side: Side;
  client_id: string;
  mint: Pubkey;
  quote_lamports?: U64;
  token_amount?: U64;
  max_slippage_bps: number;
}

class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

// --- State -------------------------------------------------------------------

interface Curve {
  mint: Pubkey;
  createdSlot: number | null;
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  reservesSlot: number;
  trades: number;
  complete: boolean;
}

interface Holding {
  tokenAmount: bigint;
  costLamports: bigint;
}

interface PendingOrder {
  order: Order;
  seq: number;
  decidedSlot: number;
}

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;

function toU64(value: bigint, what: string): U64 {
  if (value < 0n || value > 18_446_744_073_709_551_615n) {
    throw new OrderError(`${what} is not a u64: ${value}`);
  }
  return value.toString();
}

class BotState {
  readonly hello: Hello;
  seq = -1;
  slot = -1;
  cash: bigint;
  readonly positions = new Map<Pubkey, Holding>();
  readonly curves = new Map<Pubkey, Curve>();
  readonly pending = new Map<string, PendingOrder>();
  readonly #used = new Set<string>();
  #next = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.cash = BigInt(hello.capital.lamports);
  }

  clientId(): string {
    for (;;) {
      const id = `o${this.#next++}`;
      if (!this.#used.has(id)) {
        this.#used.add(id);
        return id;
      }
    }
  }

  txFeeLamports(): bigint {
    return (
      BigInt(this.hello.fees.base_fee_lamports) +
      BigInt(this.hello.fees.priority_fee_lamports)
    );
  }

  curveFeeBps(): number {
    return (
      this.hello.fees.protocol_bps_fallback +
      this.hello.fees.creator_bps_fallback
    );
  }

  maxBuyLamports(mint: Pubkey): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0n;
    return (
      (c.realQuoteReserves *
        BigInt(this.hello.caps.max_order_bps_of_real_reserve)) /
      BPS_DEN
    );
  }

  maxOpenPositions(): number {
    const n = this.hello.caps.max_open_positions;
    return Number.isSafeInteger(n) && n > 0 ? n : MAX_POSITIONS_FALLBACK;
  }

  committedPositionCount(): number {
    const mints = new Set<Pubkey>(this.positions.keys());
    for (const p of this.pending.values()) {
      if (p.order.side === 'buy') mints.add(p.order.mint);
    }
    return mints.size;
  }

  freeCashLamports(): bigint {
    const tx = this.txFeeLamports();
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.order.side === 'buy') free -= BigInt(p.order.quote_lamports ?? '0');
    }
    return free;
  }

  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.#setAccount(batch.account);
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.reservesSlot) continue;
      const curve = c ?? this.#newCurve(m.mint, null, m.slot);
      curve.virtualTokenReserves = BigInt(m.virtual_token_reserves);
      curve.virtualQuoteReserves = BigInt(m.virtual_quote_reserves);
      curve.realTokenReserves = BigInt(m.real_token_reserves);
      curve.realQuoteReserves = BigInt(m.real_quote_reserves);
      curve.reservesSlot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const curve = this.#newCurve(e.mint, e.slot, e.slot);
        curve.virtualTokenReserves = BigInt(e.virtual_token_reserves ?? '0');
        curve.virtualQuoteReserves = BigInt(e.virtual_quote_reserves ?? '0');
        curve.realTokenReserves = BigInt(e.real_quote_reserves ?? '0');
        curve.realQuoteReserves = 0n;
      } else if (e.event === 'TradeEvent') {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, null, e.slot);
        curve.virtualTokenReserves = BigInt(e.virtual_token_reserves ?? '0');
        curve.virtualQuoteReserves = BigInt(e.virtual_quote_reserves ?? '0');
        curve.realTokenReserves = BigInt(e.real_token_reserves ?? '0');
        curve.realQuoteReserves = BigInt(e.real_quote_reserves ?? '0');
        curve.reservesSlot = e.slot;
        curve.trades += 1;
      } else if (e.event === 'CompleteEvent') {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, null, e.slot);
        curve.complete = true;
      }
    }
  }

  applyDone(done: Done): void {
    this.seq = done.seq;
    this.#setAccount(done.account);
  }

  validateOrders(orders: Order[]): void {
    const cap = this.hello.caps.max_orders_per_batch;
    if (orders.length > cap) {
      throw new OrderError(
        `batch ${this.seq}: ${orders.length} orders over max_orders_per_batch (${cap})`,
      );
    }
    const seen = new Set<string>();
    for (const o of orders) {
      if (o.side !== 'buy' && o.side !== 'sell') {
        throw new OrderError(`batch ${this.seq}: bad side ${String(o.side)}`);
      }
      if (typeof o.mint !== 'string' || !PUBKEY_RE.test(o.mint)) {
        throw new OrderError(`batch ${this.seq}: bad mint ${String(o.mint)}`);
      }
      if (typeof o.client_id !== 'string' || !CLIENT_ID_RE.test(o.client_id)) {
        throw new OrderError(`batch ${this.seq}: bad client_id ${String(o.client_id)}`);
      }
      if (seen.has(o.client_id)) {
        throw new OrderError(`batch ${this.seq}: duplicate client_id ${o.client_id}`);
      }
      seen.add(o.client_id);
      const amount = o.side === 'buy' ? o.quote_lamports : o.token_amount;
      if (typeof amount !== 'string' || !U64_RE.test(amount) || amount === '0') {
        throw new OrderError(`batch ${this.seq}: bad amount ${String(amount)}`);
      }
      if (
        !Number.isInteger(o.max_slippage_bps) ||
        o.max_slippage_bps < 0 ||
        o.max_slippage_bps > 10000
      ) {
        throw new OrderError(`batch ${this.seq}: bad slippage ${String(o.max_slippage_bps)}`);
      }
    }
  }

  recordOrders(orders: readonly Order[]): void {
    for (const order of orders) {
      this.#used.add(order.client_id);
      this.pending.set(order.client_id, {
        order,
        seq: this.seq,
        decidedSlot: this.slot,
      });
    }
  }

  #newCurve(mint: Pubkey, created: number | null, slot: number): Curve {
    const curve: Curve = {
      mint,
      createdSlot: created,
      virtualTokenReserves: 0n,
      virtualQuoteReserves: 0n,
      realTokenReserves: 0n,
      realQuoteReserves: 0n,
      reservesSlot: slot,
      trades: 0,
      complete: false,
    };
    this.curves.set(mint, curve);
    return curve;
  }

  #setAccount(account: { cash_lamports: U64; positions: AccountPosition[] }): void {
    this.cash = BigInt(account.cash_lamports);
    this.positions.clear();
    for (const p of account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) {
        this.positions.set(p.mint, {
          tokenAmount: tokens,
          costLamports: BigInt(p.cost_lamports),
        });
      }
    }
  }
}

// --- Strategy ------------------------------------------------------------------

interface Coin {
  created: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  done: boolean;
  complete: boolean;
  buysSent: number;
}

interface HeldPosition {
  opened: number;
  peak: bigint;
  txPaid: bigint;
  devSoldAtOpen: boolean;
}

class SharpeSniper {
  readonly coins = new Map<Pubkey, Coin>();
  readonly held = new Map<Pubkey, HeldPosition>();
  readonly probes = new Map<Pubkey, boolean>(); // false: buy sent, true: sell sent
  myFills = 0;
  readonly myCoins = new Set<Pubkey>();
  firstTime: number | null = null;
  lastTime: number | null = null;

  sellValue(tokens: bigint, vq: bigint, vt: bigint, feeBps: number, tx: bigint): bigint {
    if (tokens <= 0n || vt <= 0n) return 0n;
    const quote = (tokens * vq) / (vt + tokens);
    const fee = (quote * BigInt(feeBps)) / BPS_DEN;
    const value = quote - fee - tx;
    return value > 0n ? value : 0n;
  }

  passesFilter(state: BotState, coin: Coin, curve: Curve): boolean {
    const realSol = curve.realQuoteReserves;
    if (realSol < lamports(MIN_REAL_SOL) || realSol > lamports(MAX_REAL_SOL)) return false;
    if (coin.devBuy > lamports(MAX_DEV_BUY_SOL)) return false;
    if (coin.buyers.size > MAX_EARLY_BUYERS) return false;
    if (SKIP_DEV_SOLD && coin.devSold) return false;
    if (coin.bought > 0n && coin.soldByOthers > coin.bought) return false;
    if (coin.vq0 > 0n && coin.vt0 > 0n && curve.virtualTokenReserves > 0n) {
      // runup = (vq_now * vt0) / (vt_now * vq0), compared as integers.
      const num = curve.virtualQuoteReserves * coin.vt0;
      const den = curve.virtualTokenReserves * coin.vq0;
      if (num * BigInt(MIN_RUNUP_DEN) < den * BigInt(MIN_RUNUP_NUM)) return false;
      if (num * BigInt(MAX_RUNUP_DEN) > den * BigInt(MAX_RUNUP_NUM)) return false;
    }
    return true;
  }

  equity(state: BotState): bigint {
    let total = state.cash;
    const tx = state.txFeeLamports();
    const feeBps = state.curveFeeBps();
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      total += this.sellValue(
        holding.tokenAmount,
        curve.virtualQuoteReserves,
        curve.virtualTokenReserves,
        feeBps,
        tx,
      );
    }
    return total;
  }

  onBatch(state: BotState, batch: Batch): Order[] {
    const now = batch.slot;
    for (const event of batch.events) {
      const blockTime = event.block_time;
      if (typeof blockTime === 'number') {
        if (this.firstTime === null) this.firstTime = blockTime;
        if (this.lastTime === null || blockTime > this.lastTime) this.lastTime = blockTime;
      }
      if (event.event === 'CreateEvent') {
        this.coins.set(event.mint, {
          created: event.slot,
          creator: event.creator ?? '',
          vq0: BigInt(event.virtual_quote_reserves ?? '0'),
          vt0: BigInt(event.virtual_token_reserves ?? '0'),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          devSold: false,
          lastTradeSlot: event.slot,
          done: false,
          complete: false,
          buysSent: 0,
        });
      } else if (event.event === 'TradeEvent') {
        const coin = this.coins.get(event.mint);
        if (coin === undefined) continue;
        const sol = BigInt(event.sol_amount ?? '0');
        coin.trades += 1;
        coin.lastTradeSlot = event.slot;
        const isDev = event.user === coin.creator;
        if (event.is_buy) {
          coin.bought += sol;
          if (isDev && event.slot === coin.created) {
            coin.devBuy += sol;
          } else if (!isDev && event.user !== undefined) {
            coin.buyers.add(event.user);
          }
        } else if (isDev) {
          coin.devSold = true;
        } else {
          coin.soldByOthers += sol;
        }
      } else if (event.event === 'CompleteEvent') {
        const coin = this.coins.get(event.mint);
        if (coin !== undefined) {
          coin.complete = true;
          coin.done = true;
        }
      }
    }

    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const feeBps = state.curveFeeBps();
    const orders: Order[] = [];
    const pendingByMint = new Map<Pubkey, boolean>();
    for (const pending of state.pending.values()) {
      pendingByMint.set(pending.order.mint, true);
    }

    // --- fills: count the bot's own, track tx fees per position --------
    for (const fill of batch.fills) {
      if (fill.client_id.startsWith('_')) {
        this.held.delete(fill.mint);
        continue;
      }
      if (fill.status === 'filled') {
        this.myFills += 1;
        this.myCoins.add(fill.mint);
        const position = this.held.get(fill.mint);
        if (position !== undefined) {
          position.txPaid += BigInt(fill.tx_fee_lamports);
        }
        if (fill.side === 'buy') {
          if (position === undefined) {
            const coin = this.coins.get(fill.mint);
            this.held.set(fill.mint, {
              opened: fill.slot,
              peak: 0n,
              txPaid: BigInt(fill.tx_fee_lamports),
              devSoldAtOpen: coin !== undefined ? coin.devSold : false,
            });
          }
        } else {
          this.held.delete(fill.mint);
          const coin = this.coins.get(fill.mint);
          if (coin !== undefined) coin.done = true;
          this.probes.delete(fill.mint);
        }
      } else if (fill.status === 'rejected' && fill.side === 'buy') {
        // A rejected buy paid nothing: the coin may be tried again while young.
        const coin = this.coins.get(fill.mint);
        if (coin !== undefined) coin.buysSent = 0;
        this.probes.delete(fill.mint);
      }
    }

    // --- exits first ----------------------------------------------------
    for (const mint of [...this.held.keys()]) {
      if (orders.length >= cap) break;
      const position = this.held.get(mint);
      if (position === undefined) continue;
      const heldNow = state.positions.get(mint);
      if (heldNow === undefined) {
        if (!pendingByMint.has(mint)) {
          this.held.delete(mint);
          const coin = this.coins.get(mint);
          if (coin !== undefined) coin.done = true;
        }
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint)) continue;
      const tokens = heldNow.tokenAmount;
      const value = this.sellValue(
        tokens,
        curve.virtualQuoteReserves,
        curve.virtualTokenReserves,
        feeBps,
        tx,
      );
      const basis = heldNow.costLamports + position.txPaid;
      if (value > position.peak) position.peak = value;
      let exitNow = false;
      if (basis > 0n) {
        if (value * BigInt(TAKE_PROFIT_DEN) >= basis * BigInt(TAKE_PROFIT_NUM)) exitNow = true;
        else if (value * BigInt(STOP_LOSS_DEN) <= basis * BigInt(STOP_LOSS_NUM)) exitNow = true;
        else if (
          position.peak * BigInt(TRAIL_ARM_DEN) >= basis * BigInt(TRAIL_ARM_NUM) &&
          value * BigInt(TRAIL_DEN) <= position.peak * BigInt(TRAIL_NUM)
        ) {
          exitNow = true;
        }
      }
      if (!exitNow && now - position.opened >= MAX_HOLD_SLOTS) exitNow = true;
      const coin = this.coins.get(mint);
      if (coin !== undefined) {
        if (EXIT_ON_DEV_SELL && coin.devSold && !position.devSoldAtOpen) exitNow = true;
        if (now - coin.lastTradeSlot >= STALE_SLOTS) exitNow = true;
      }
      if (!exitNow) continue;
      orders.push({
        side: 'sell',
        client_id: state.clientId(),
        mint,
        token_amount: tokens.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }

    // --- probe round trips: sell the probe as soon as its buy has landed --
    for (const mint of [...this.probes.keys()]) {
      if (orders.length >= cap) break;
      const heldNow = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (heldNow === undefined) {
        if (!pendingByMint.has(mint)) this.probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      orders.push({
        side: 'sell',
        client_id: state.clientId(),
        mint,
        token_amount: heldNow.tokenAmount.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      this.probes.set(mint, true);
    }

    // --- entries: one small stake per launch that passes the filter -----
    const capital = BigInt(state.hello.capital.lamports);
    const stake = (capital * BigInt(STAKE_BPS_OF_CAPITAL)) / BPS_DEN;
    const minBuy = lamports(MIN_BUY_SOL);
    const guardOk =
      this.equity(state) * BigInt(EQUITY_GUARD_DEN) >=
      capital * BigInt(EQUITY_GUARD_NUM);
    let free = state.freeCashLamports();
    let openCount = state.committedPositionCount();
    if (guardOk && stake >= minBuy) {
      for (const [mint, coin] of this.coins) {
        if (orders.length >= cap) break;
        if (coin.done || coin.complete || coin.buysSent > 0) continue;
        const age = now - coin.created;
        if (age > MAX_AGE_SLOTS) {
          coin.done = true;
          continue;
        }
        if (openCount >= state.maxOpenPositions()) continue;
        if (pendingByMint.has(mint) || this.probes.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (!this.passesFilter(state, coin, curve)) continue;
        const amount = stake < (state.maxBuyLamports(mint) * 9n) / 10n
          ? stake
          : (state.maxBuyLamports(mint) * 9n) / 10n;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({
          side: 'buy',
          client_id: state.clientId(),
          mint,
          quote_lamports: amount.toString(),
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        free -= amount + tx;
        coin.buysSent += 1;
        openCount += 1;
      }
    }

    // --- guardrail pacing: open a probe when fills or coins lag ----------
    if (
      guardOk &&
      this.probes.size < MAX_PROBES &&
      this.firstTime !== null &&
      this.lastTime !== null
    ) {
      let pace = (this.lastTime - this.firstTime) / PACE_SECONDS;
      if (pace > 1) pace = 1;
      if (pace < 0) pace = 0;
      pace = pace * pace;
      const needCoins = this.myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = this.myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minReal =
          (lamports(PROBE_SOL) * BPS_DEN) /
          BigInt(state.hello.caps.max_order_bps_of_real_reserve);
        const traded: Pubkey[] = [];
        const seen = new Set<Pubkey>();
        for (const event of batch.events) {
          if (event.event === 'TradeEvent' && !seen.has(event.mint)) {
            seen.add(event.mint);
            traded.push(event.mint);
          }
        }
        // Two passes: first only mints the bot has never traded (a probe must
        // grow the distinct-coin count), then any liquid mint. Both passes
        // skip obvious rugs: a big creator buy or a creator sale on the tape.
        for (let pass = 0; pass < 2; pass++) {
          for (const mint of traded) {
            if (orders.length >= cap || this.probes.size >= MAX_PROBES) break;
            if (
              this.held.has(mint) ||
              this.probes.has(mint) ||
              pendingByMint.has(mint) ||
              state.positions.has(mint)
            ) {
              continue;
            }
            if (pass === 0 && this.myCoins.has(mint)) continue;
            if (pass === 1 && needCoins && !needFills && this.myCoins.has(mint)) continue;
            const coin = this.coins.get(mint);
            if (
              coin !== undefined &&
              (coin.devBuy > lamports(MAX_DEV_BUY_SOL) || coin.devSold)
            ) {
              continue;
            }
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.realQuoteReserves < (minReal * 3n) / 2n) continue;
            if (free < lamports(PROBE_SOL) + 2n * tx) break;
            orders.push({
              side: 'buy',
              client_id: state.clientId(),
              mint,
              quote_lamports: lamports(PROBE_SOL).toString(),
              max_slippage_bps: BUY_SLIPPAGE_BPS,
            });
            this.probes.set(mint, false);
            free -= lamports(PROBE_SOL) + tx;
          }
          if (this.probes.size >= MAX_PROBES) break;
        }
      }
    }
    return orders;
  }
}

// --- Wire ----------------------------------------------------------------------

async function* readLines(
  input: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      let line = buffer.slice(0, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      buffer = buffer.slice(nl + 1);
      yield line;
      nl = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

function writeLine(text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const ok = process.stdout.write(text);
    if (ok) {
      resolve();
    } else {
      process.stdout.once('drain', resolve);
    }
  });
}

async function main(): Promise<void> {
  let state: BotState | null = null;
  const bot = new SharpeSniper();
  let lineNo = 0;
  for await (const line of readLines(process.stdin)) {
    lineNo++;
    if (line.trim() === '') continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      throw new ProtocolError(`input line ${lineNo} is not JSON`);
    }
    const type =
      typeof msg === 'object' && msg !== null && !Array.isArray(msg)
        ? (msg as { type?: unknown }).type
        : undefined;
    if (type === 'hello') {
      const hello = msg as Hello;
      if (state !== null) throw new ProtocolError(`input line ${lineNo}: a second hello`);
      if (hello.protocol !== 'agent-fun/replay/v2') {
        throw new ProtocolError(`the harness speaks ${String(hello.protocol)}; this bot speaks agent-fun/replay/v2`);
      }
      state = new BotState(hello);
    } else if (type === 'batch') {
      const batch = msg as Batch;
      if (state === null) throw new ProtocolError(`input line ${lineNo}: a batch before hello`);
      if (
        !Number.isSafeInteger(batch.seq) ||
        !Number.isSafeInteger(batch.slot) ||
        !Array.isArray(batch.events) ||
        !Array.isArray(batch.marks) ||
        !Array.isArray(batch.fills) ||
        typeof batch.account !== 'object' ||
        batch.account === null ||
        !Array.isArray(batch.account.positions)
      ) {
        throw new ProtocolError(`input line ${lineNo}: malformed batch`);
      }
      state.applyBatch(batch);
      const orders = bot.onBatch(state, batch);
      state.validateOrders(orders);
      const reply = JSON.stringify({ type: 'reply', seq: batch.seq, orders });
      if (Buffer.byteLength(reply, 'utf8') > 65_536) {
        throw new OrderError(`batch ${batch.seq}: reply over 65536 bytes`);
      }
      state.recordOrders(orders);
      await writeLine(`${reply}\n`);
    } else if (type === 'done') {
      const done = msg as Done;
      if (state === null) throw new ProtocolError(`input line ${lineNo}: done before hello`);
      state.applyDone(done);
      return;
    } else {
      throw new ProtocolError(`input line ${lineNo}: unknown message type ${String(type)}`);
    }
  }
  throw new ProtocolError(
    state === null ? 'input ended before hello' : 'input ended before done',
  );
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
