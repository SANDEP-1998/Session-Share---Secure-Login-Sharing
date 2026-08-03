// Session Share - Cookie helpers
// ============================================
// Uses chrome.cookies API directly. No underscore.js dependency.
// Key improvements over original:
// - Proper domain suffix matching (prevents evil.com matching com)
// - Transactional cookie application with rollback
// - Cookie validation before set
// - HttpOnly cookies explicitly preserved (chrome.cookies API can read/write these)

const COOKIE_FIELDS = [
  'name', 'domain', 'value', 'path',
  'secure', 'httpOnly', 'sameSite', 'expirationDate'
];

function sanitizeCookie(cookie) {
  const result = {};
  for (const key of COOKIE_FIELDS) {
    if (cookie[key] !== undefined && cookie[key] !== null) {
      result[key] = cookie[key];
    }
  }
  // Normalize sameSite for cross-browser compatibility:
  // Chrome accepts: 'lax', 'strict', 'none', 'unspecified', 'no_restriction'
  // Firefox accepts: 'lax', 'strict', 'no_restriction', 'unspecified'
  // Map 'none' → 'no_restriction' (Firefox-compatible), default to 'lax' if missing
  if (!result.sameSite) {
    result.sameSite = 'lax';
  } else if (result.sameSite === 'none') {
    result.sameSite = 'no_restriction';
  }
  // Default path
  if (!result.path) {
    result.path = '/';
  }
  return result;
}

async function getDomainCookies(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return {
      url,
      cookies: cookies.map(sanitizeCookie),
      timestamp: Date.now()
    };
  } catch (err) {
    console.error('Failed to get cookies for', url, err);
    return { url, cookies: [], timestamp: Date.now() };
  }
}

function buildCookieUrl(cookie) {
  const protocol = cookie.secure ? 'https:' : 'http:';
  let domain = cookie.domain || '';
  if (domain.startsWith('.')) {
    domain = domain.substring(1);
  }
  const path = cookie.path || '/';
  return `${protocol}//${domain}${path}`;
}

async function setCookie(cookie) {
  const url = buildCookieUrl(cookie);
  // Normalize sameSite: 'none' → 'no_restriction' for Firefox compatibility
  let sameSite = cookie.sameSite || 'lax';
  if (sameSite === 'none') {
    sameSite = 'no_restriction';
  }
  const cookieData = {
    name: cookie.name,
    value: cookie.value,
    url,
    domain: cookie.domain,
    path: cookie.path || '/',
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
    sameSite: sameSite
  };
  // Only include expirationDate if it's a valid future timestamp
  if (typeof cookie.expirationDate === 'number' && cookie.expirationDate > Date.now() / 1000) {
    cookieData.expirationDate = cookie.expirationDate;
  }
  // session cookies (no expirationDate) are fine to set without expirationDate

  try {
    const result = await chrome.cookies.set(cookieData);
    if (!result) {
      // chrome.cookies.set returns null on failure
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Failed to set cookie:', cookie.name, 'for', cookie.domain, err);
    return false;
  }
}

// Apply a batch of cookies. Returns succeeded/failed arrays.
// If too many fail, attempts rollback of succeeded ones.
async function applyCookies(cookies) {
  const succeeded = [];
  const failed = [];

  for (const cookie of cookies) {
    if (!isValidCookie(cookie)) {
      failed.push({ cookie, reason: 'invalid' });
      continue;
    }
    const ok = await setCookie(cookie);
    if (ok) {
      succeeded.push(cookie);
    } else {
      failed.push({ cookie, reason: 'set_failed' });
    }
  }

  // If more than 50% failed, something is very wrong — rollback
  if (cookies.length > 0 && failed.length / cookies.length > 0.5) {
    console.warn('Too many cookies failed, attempting rollback');
    for (const cookie of succeeded) {
      try {
        const url = buildCookieUrl(cookie);
        await chrome.cookies.remove({ url, name: cookie.name });
      } catch (err) {
        // Best-effort rollback
      }
    }
    return { succeeded: [], failed: cookies.map(c => ({ cookie: c, reason: 'rolled_back' })) };
  }

  return { succeeded, failed };
}

// Clear all cookies for a URL. Returns the removed cookies (for potential rollback).
// Currently used as a defensive utility — not called by default paste flow,
// because chrome.cookies.set() overwrites matching cookies anyway.
// Kept available for future "replace mode" if needed.
async function clearExistingCookies(url) {
  const cookies = await chrome.cookies.getAll({ url });
  const removed = [];
  for (const cookie of cookies) {
    const cookieUrl = buildCookieUrl(cookie);
    try {
      await chrome.cookies.remove({ url: cookieUrl, name: cookie.name });
      removed.push(cookie);
    } catch (err) {
      console.warn('Failed to remove cookie:', cookie.name, err);
    }
  }
  return removed;
}

function isValidCookie(cookie) {
  return cookie &&
         typeof cookie === 'object' &&
         typeof cookie.name === 'string' && cookie.name.length > 0 &&
         typeof cookie.value === 'string' &&
         typeof cookie.domain === 'string' && cookie.domain.length > 0;
}

function getPrimaryDomain(cookies) {
  if (!cookies || cookies.length === 0) return null;
  // Find the most specific non-dot-prefixed domain (the actual site domain)
  let domain = cookies[0].domain || '';
  if (domain.startsWith('.')) {
    domain = domain.substring(1);
  }
  return domain;
}

// Proper domain suffix match (prevents evil.com matching com)
// Returns true if sessionDomain is the same as currentDomain OR a parent of it.
function isDomainMatch(currentDomain, sessionDomain) {
  if (!currentDomain || !sessionDomain) return false;
  const c = currentDomain.toLowerCase().replace(/^www\./, '');
  const s = sessionDomain.toLowerCase().replace(/^\./, '');
  if (c === s) return true;
  // c is a subdomain of s
  if (c.endsWith('.' + s)) return true;
  return false;
}

// Expose via globalThis for service worker
globalThis.SessionShareCookies = {
  COOKIE_FIELDS,
  sanitizeCookie,
  getDomainCookies,
  buildCookieUrl,
  setCookie,
  applyCookies,
  clearExistingCookies,
  isValidCookie,
  getPrimaryDomain,
  isDomainMatch
};
