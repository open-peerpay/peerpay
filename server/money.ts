import { NOTIFICATION_AMOUNT_MACRO } from "../src/shared/constants";

const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;
const MONEY_PATTERN = "\\d+(?:\\.\\d{1,2})?";
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

export function parseMoney(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("金额必须是非负数字");
    }
    return parseMoneyText(String(value));
  }

  return parseMoneyText(value);
}

function parseMoneyText(value: string) {
  const normalized = value.trim();
  if (!MONEY_RE.test(normalized)) {
    throw new Error("金额格式无效，请使用最多两位小数");
  }

  const [yuan, fraction = ""] = normalized.split(".");
  const cents = BigInt(yuan) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > MAX_SAFE_CENTS) {
    throw new Error("金额超出安全整数范围");
  }
  return Number(cents);
}

export function formatMoney(cents: number | null | undefined): string | null {
  if (cents == null) {
    return null;
  }

  const yuan = Math.trunc(cents / 100);
  const fraction = Math.abs(cents % 100).toString().padStart(2, "0");
  return `${yuan}.${fraction}`;
}

export function extractMoneyByTemplate(text: string, template: string): number | null {
  const parts = template.split(NOTIFICATION_AMOUNT_MACRO);
  if (parts.length !== 2) {
    return null;
  }

  const pattern = `${escapeRegExp(parts[0])}(${MONEY_PATTERN})${escapeRegExp(parts[1])}`;
  const match = new RegExp(pattern, "i").exec(text);
  return match?.[1] ? parseMoney(match[1]) : null;
}

export function extractMoneyByTemplates(text: string, templates: string[]): number | null {
  for (const template of templates) {
    const amountCents = extractMoneyByTemplate(text, template);
    if (amountCents != null) {
      return amountCents;
    }
  }

  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
