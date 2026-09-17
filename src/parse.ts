// Parsers for values that arrive as text: settings and request headers.

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
