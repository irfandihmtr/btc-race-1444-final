// Halcyon Breakout
//
// A quiet cbBTC/USDC bot for the one-minute bars replay. It waits for a
// half-hour close that breaks cleanly above the eight half-hour closes
// before it, while price is still below where it stood twelve hours
// earlier: a recovery breakout, not a chase at the top. It buys half the
// account, then lets a tight trailing stop, a maximum hold, or a lost
// half-hour trend take it out again. Most bars it does nothing at all.
//
// The half-hour series is sampled from the one-minute closes at every
// thirtieth bar, counting from the first bar of the window, and its
// exponential average is seeded with the very first sampled close.
// Everything below is a pure function of the bars seen so far: no clock,
// no randomness, no environment, no network.

import { runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const BAR30 = 30;
const LOOKBACK = 8;
const EMA_N = 8;
const WARMUP = 240;
const MIN_BAR_GAIN = 0.002;
const RET12H_BARS = 720;
const TRAIL = 0.007;
const MAX_HOLD = 360;
const SIZE_FRAC = 0.5;
const MAX_SLIP_BPS = 500;

const closes: number[] = [];
const halfHourCloses: number[] = [];
let emaHalfHour: number | null = null;
let entryBar = -1;
let peakSinceEntry = 0;

function noteHalfHourClose(close: number): void {
  halfHourCloses.push(close);
  if (emaHalfHour === null) {
    emaHalfHour = close;
    return;
  }
  const k = 2 / (EMA_N + 1);
  emaHalfHour = emaHalfHour + k * (close - emaHalfHour);
}

function twelveHourReference(barIndex: number): number {
  const back = barIndex - RET12H_BARS;
  const at = back >= 0 ? back : 0;
  return closes[at]!;
}

function breakoutReady(barIndex: number, close: number): boolean {
  if (barIndex < WARMUP) return false;
  if (halfHourCloses.length < LOOKBACK + 1) return false;
  const j = halfHourCloses.length - 1;
  const current = halfHourCloses[j]!;
  const previous = halfHourCloses[j - 1]!;
  let highestBefore = 0;
  for (let i = j - LOOKBACK; i < j; i++) {
    if (halfHourCloses[i]! > highestBefore) highestBefore = halfHourCloses[i]!;
  }
  if (!(current > highestBefore)) return false;
  if (!(current / previous - 1 > MIN_BAR_GAIN)) return false;
  if (emaHalfHour === null || !(current > emaHalfHour)) return false;
  if (!(close < twelveHourReference(barIndex))) return false;
  return true;
}

await runBars({
  onBatch(state, batch) {
    const orders: (BuyInput | SellInput)[] = [];
    for (const bar of batch.bars) {
      if (bar.symbol !== 'CBBTC') continue;
      const close = Number(bar.c);
      closes.push(close);
      const barIndex = closes.length - 1;
      const isHalfHour = barIndex % BAR30 === 0;
      if (isHalfHour) noteHalfHourClose(close);

      const held = state.positions.get('CBBTC');

      if (held !== undefined && held.qty > 0n) {
        // We are in a position: tend the peak first, then the exits.
        if (close > peakSinceEntry) peakSinceEntry = close;
        const trailedOff = close < peakSinceEntry * (1 - TRAIL);
        const heldTooLong = entryBar >= 0 && barIndex - entryBar > MAX_HOLD;
        const trendLost =
          halfHourCloses.length > 0 &&
          emaHalfHour !== null &&
          halfHourCloses[halfHourCloses.length - 1]! < emaHalfHour;
        if (trailedOff || heldTooLong || trendLost) {
          orders.push({
            side: 'sell',
            symbol: 'CBBTC',
            qty: held.qty,
            max_slippage_bps: MAX_SLIP_BPS,
          });
        }
        continue;
      }

      // Flat and not holding: entry is only ever judged on a fresh
      // half-hour close. A buy decided here fills at the next bar's open,
      // and by the next half-hour close the position is on the account,
      // so no separate pending flag is needed to avoid a duplicate buy.
      if (!isHalfHour) continue;
      if (!breakoutReady(barIndex, close)) continue;

      const notional = (state.equity * BigInt(Math.round(SIZE_FRAC * 10000))) / 10000n;
      if (notional <= 0n) continue;
      orders.push({
        side: 'buy',
        symbol: 'CBBTC',
        notional_quote_units: notional,
        max_slippage_bps: MAX_SLIP_BPS,
      });
      entryBar = barIndex;
      peakSinceEntry = close;
    }
    return orders;
  },
});
