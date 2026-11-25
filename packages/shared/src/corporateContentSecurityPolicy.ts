// Chromium rejects IPv6 literal CSP sources; UI services use localhost or 127.0.0.1.
const localOrigins = ["127.0.0.1", "localhost"]
  .flatMap((host) => ["http", "https"].map((scheme) => `${scheme}://${host}:*`))
  .join(" ");
const localSockets = ["127.0.0.1", "localhost"]
  .flatMap((host) => ["ws", "wss"].map((scheme) => `${scheme}://${host}:*`))
  .join(" ");

export const corporateContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  `connect-src 'self' blob: ${localOrigins} ${localSockets}`,
  `img-src 'self' blob: data: ${localOrigins}`,
  `media-src 'self' blob: ${localOrigins}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  `frame-src 'self' blob: ${localOrigins}`,
  `object-src 'self' blob: ${localOrigins}`,
  "form-action 'self'",
].join("; ");
