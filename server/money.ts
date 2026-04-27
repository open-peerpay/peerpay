const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;
const TEXT_AMOUNT_RE = /(?:¥|￥|金额|收款|到账|入账|收入|付款)?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|CNY|RMB)?/gi;
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

export function extractMoneyFromText(text: string): number | null {
  const matches = Array.from(text.matchAll(TEXT_AMOUNT_RE))
    .map((match) => match[1])
    .filter(Boolean);

  if (matches.length === 0) {
    return null;
  }

  return parseMoney(matches[0]);
}
