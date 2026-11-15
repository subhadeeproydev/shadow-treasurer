// Deterministic evidence screening. Always runs, with or without Claude: defence in depth.
import type { Currency, EvidenceDoc, EvidenceSignal } from '../domain/types.ts';

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |any )?(previous|prior|above) (instructions|rules)/i,
  /\b(ai|assistant|agent|llm|bot)\b[^.]{0,40}\b(must|should|are instructed to|please)\b[^.]{0,40}\b(pay|transfer|send|approve|release)/i,
  /system prompt|developer mode|you are now/i,
  /do not (tell|inform|notify|escalate)/i,
  /(bypass|skip|override) (the )?(approval|mandate|limit|check)/i,
];

const BANK_CHANGE = /(new|updated|changed|different) (bank|account|iban|banking|payment) (details|account|information|number)/i;
const DELAY = /(paying|pay|payment|transfer|remit)[^.]{0,40}\b(in|within|after|next)\s+(two|2|three|3|four|4)\s+weeks|\b(delayed|delay|late|postpone|push back)\b/i;
const CONFIRMED = /(payment|transfer|remittance)[^.]{0,30}(sent|initiated|released|on its way)/i;
const PAY_REQUEST = /(please|kindly) (pay|settle|remit)|amount due|payment due|settle invoice/i;
const URGENT = /\b(urgent|immediately|today|asap|right away)\b/i;
const AMOUNT = /\b(USD|EUR|GBP|AUD)\s?([\d,]+(?:\.\d{1,2})?)\b/;

export interface ScreenResult {
  readonly injectionSuspected: boolean;
  readonly reason?: string;
}

export const screenForInjection = (doc: EvidenceDoc): ScreenResult => {
  const hit = INJECTION_PATTERNS.find((p) => p.test(doc.body) || p.test(doc.subject));
  return hit ? { injectionSuspected: true, reason: `matched rule ${hit.source.slice(0, 40)}…` } : { injectionSuspected: false };
};

const quote = (body: string, re: RegExp): string => {
  const m = body.match(re);
  if (!m || m.index === undefined) return body.slice(0, 120);
  const start = body.lastIndexOf('.', m.index) + 1;
  const end = body.indexOf('.', m.index + m[0].length);
  return body.slice(start, end === -1 ? undefined : end + 1).trim();
};

const sender = (from: string): string => from.replace(/<.*>/, '').trim();

/** Rule-based extraction used when no ANTHROPIC_API_KEY is configured (and in tests / the Gauntlet). */
export const extractWithRules = (doc: EvidenceDoc): readonly EvidenceSignal[] => {
  const text = `${doc.subject}. ${doc.body}`;
  const amountMatch = text.match(AMOUNT);
  const currency = amountMatch ? (amountMatch[1] as Currency) : undefined;
  const amount = amountMatch ? Number(amountMatch[2].replace(/,/g, '')) : undefined;
  const counterparty = sender(doc.from);
  const signals: EvidenceSignal[] = [];
  if (BANK_CHANGE.test(text)) signals.push({ type: 'bank_details_change', counterparty, currency, amount, citation: quote(text, BANK_CHANGE) });
  if (DELAY.test(text)) signals.push({ type: 'deposit_delay', counterparty, currency, amount, citation: quote(text, DELAY) });
  if (CONFIRMED.test(text) && !DELAY.test(text)) signals.push({ type: 'deposit_confirmed', counterparty, currency, amount, citation: quote(text, CONFIRMED) });
  if (doc.kind === 'invoice' || PAY_REQUEST.test(text)) signals.push({ type: 'new_invoice', counterparty, currency, amount, citation: quote(text, PAY_REQUEST.test(text) ? PAY_REQUEST : /invoice/i) });
  if (URGENT.test(text)) signals.push({ type: 'payment_urgency', counterparty, citation: quote(text, URGENT) });
  return signals;
};
