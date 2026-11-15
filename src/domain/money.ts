import type { Balances, Currency, Rates } from './types.ts';
import { CURRENCIES } from './types.ts';

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export const toBase = (amount: number, currency: Currency, rates: Rates): number =>
  round2(amount * rates[currency]);

export const fromBase = (amountBase: number, currency: Currency, rates: Rates): number =>
  round2(amountBase / rates[currency]);

export const totalBase = (balances: Balances, rates: Rates): number =>
  round2(CURRENCIES.reduce((sum, c) => sum + toBase(balances[c] ?? 0, c, rates), 0));

export const withDelta = (balances: Balances, currency: Currency, delta: number): Balances => ({
  ...balances,
  [currency]: round2((balances[currency] ?? 0) + delta),
});

export const hoursUntil = (iso: string, now: Date): number =>
  (new Date(iso).getTime() - now.getTime()) / 3_600_000;

export const fmt = (amount: number, currency: Currency): string =>
  `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
