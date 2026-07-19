// ahgiz-api/src/utils/request.js
// The single source of truth for client identity (IP + device) — do not read req.ip
// directly anywhere else.
//
// Root cause (2026-07-13): the codebase wrote this everywhere:
//     req.ip || req.headers['x-forwarded-for']?.split(',')[0] || null
// which is wrong on both sides:
//   1. req.ip is always truthy (never undefined) => the second branch is DEAD CODE
//      that has never once executed.
//   2. Without app.set('trust proxy'), Express ignores the X-Forwarded-For header
//      entirely, so req.ip is Railway's edge IP — not the client's.
// Result: every admin_audit_log row recorded the proxy's IP, and every rate limiter
// counted the whole world in a single bucket.
//
// The fix lives in app.js (trust proxy) plus this unified read. See app.js for how
// the hop count is configured.

// The real client IP. Depends entirely on trust proxy being set correctly in app.js.
const clientIp = (req) => req.ip || null;

const userAgent = (req) => req.headers['user-agent'] || null;

// The raw chain as it arrived — for diagnostics only, never to be trusted.
// We surface it in the break-glass alert so the owner can see with their own eyes
// that the hop count is right: if clientIp shows the real client, the setting is
// correct; if it shows an internal IP, the hop count is wrong.
const forwardedChain = (req) => req.headers['x-forwarded-for'] || null;

const clientMeta = (req) => ({
  ip_address: clientIp(req),
  user_agent: userAgent(req),
});

module.exports = { clientIp, userAgent, forwardedChain, clientMeta };
