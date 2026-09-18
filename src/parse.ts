// Parsers for values that arrive as text: settings and request headers.

// A whole number written with digits only, or null. Every integer setting is
// read with this: Number() alone would accept "1e3", " 5", "0x10" and "5.0".
export function wholeNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

// The lower-case host name a Host header (or a host list entry) names,
// without its port, or null. Parsed as the SDK's hostHeaderValidation
// middleware parses it.
export function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}
