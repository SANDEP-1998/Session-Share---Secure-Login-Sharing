// Session Share - Crypto configuration (v3 — advanced)
// ============================================
// DESIGN:
// - Local saved sessions: AES-GCM-256 with per-user master key (JWK in chrome.storage.local)
// - Shared tokens v3: AES-GCM-256 with ephemeral key + optional expiry timestamp
//   Format: v3.<expiryEpochMs>.<ephemeralKeyJwk.k>.<base64(iv + ciphertext + authTag)>
//   expiryEpochMs = 0 means no expiry (permanent)
// - Shared tokens v2: legacy format (no expiry), backward compatible
// - PIN protection: PBKDF2-SHA-256 with 100k iterations + random salt
// - IV: 12 bytes random per encryption, prepended to ciphertext
// - No external crypto dependencies. Uses native WebCrypto (crypto.subtle)

const OMNIBOX_KEYWORD = 'session_paste';
const TOKEN_VERSION = 3;
const TOKEN_PREFIX_V3 = `v${TOKEN_VERSION}.`;
const TOKEN_PREFIX_V2 = 'v2.';
const PIN_ITERATIONS = 100000;

const DEBUG = false;

function debugLog(...args) {
  if (DEBUG) console.log('[SessionShare]', ...args);
}

// ---------- Base64 helpers ----------

function base64Encode(bytes) {
  let binary = '';
  const len = bytes.length;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64Decode(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------- Master key (for local storage) ----------

async function getMasterKey() {
  try {
    const stored = await chrome.storage.local.get('masterKeyJwk');
    if (stored.masterKeyJwk) {
      return await crypto.subtle.importKey(
        'jwk',
        stored.masterKeyJwk,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      );
    }
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const jwk = await crypto.subtle.exportKey('jwk', key);
    await chrome.storage.local.set({ masterKeyJwk: jwk });
    return key;
  } catch (err) {
    console.error('Master key init failed:', err);
    throw new Error('Failed to initialize crypto key');
  }
}

async function rotateMasterKey() {
  await chrome.storage.local.remove('masterKeyJwk');
  return getMasterKey();
}

// ---------- Core encrypt/decrypt with a given key ----------

async function encryptWithKey(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return base64Encode(combined);
}

async function decryptWithKey(key, b64) {
  const combined = base64Decode(b64);
  if (combined.length < 13) {
    throw new Error('Ciphertext too short');
  }
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(decrypted);
}

// ---------- Local storage encryption (per-user master key) ----------

async function encryptLocal(plaintext) {
  const key = await getMasterKey();
  return encryptWithKey(key, plaintext);
}

async function decryptLocal(b64) {
  const key = await getMasterKey();
  return decryptWithKey(key, b64);
}

// ---------- Shared token encryption (v3 with expiry) ----------

// expiryHours: 0 = no expiry, >0 = expires after N hours
async function encryptShared(plaintext, expiryHours = 0) {
  const ephKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const encrypted = await encryptWithKey(ephKey, plaintext);
  const ephJwk = await crypto.subtle.exportKey('jwk', ephKey);
  if (!ephJwk.k) {
    throw new Error('Failed to export ephemeral key');
  }

  let expiry = 0;
  if (expiryHours > 0) {
    expiry = Date.now() + (expiryHours * 60 * 60 * 1000);
  }

  // Token: v3.<expiry>.<key>.<iv+ciphertext>
  return `${TOKEN_PREFIX_V3}${expiry}.${ephJwk.k}.${encrypted}`;
}

// Decrypt v3 token (with expiry check)
async function decryptSharedV3(token) {
  const rest = token.substring(TOKEN_PREFIX_V3.length);
  const firstDot = rest.indexOf('.');
  if (firstDot === -1) {
    throw new Error('Malformed v3 token');
  }
  const expiryStr = rest.substring(0, firstDot);
  const afterExpiry = rest.substring(firstDot + 1);
  const secondDot = afterExpiry.indexOf('.');
  if (secondDot === -1) {
    throw new Error('Malformed v3 token');
  }
  const keyB64 = afterExpiry.substring(0, secondDot);
  const ciphertext = afterExpiry.substring(secondDot + 1);

  // Check expiry
  const expiry = parseInt(expiryStr, 10);
  if (!isNaN(expiry) && expiry > 0 && Date.now() > expiry) {
    const expiredDate = new Date(expiry);
    throw new Error(`Token expired on ${expiredDate.toLocaleString()}`);
  }

  const ephKey = await crypto.subtle.importKey(
    'jwk',
    { k: keyB64, kty: 'oct', alg: 'A256GCM' },
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  return decryptWithKey(ephKey, ciphertext);
}

// Decrypt v2 token (legacy, no expiry)
async function decryptSharedV2(token) {
  const rest = token.substring(TOKEN_PREFIX_V2.length);
  const firstDot = rest.indexOf('.');
  if (firstDot === -1) {
    throw new Error('Malformed v2 token');
  }
  const keyB64 = rest.substring(0, firstDot);
  const ciphertext = rest.substring(firstDot + 1);

  const ephKey = await crypto.subtle.importKey(
    'jwk',
    { k: keyB64, kty: 'oct', alg: 'A256GCM' },
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  return decryptWithKey(ephKey, ciphertext);
}

// ---------- Universal decryptor (auto-detects v3/v2) ----------

async function decryptAny(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Empty token');
  }
  if (token.startsWith(TOKEN_PREFIX_V3)) {
    return decryptSharedV3(token);
  }
  if (token.startsWith(TOKEN_PREFIX_V2)) {
    return decryptSharedV2(token);
  }
  throw new Error('Unsupported token format. Please re-copy the session with v2.0.0+.');
}

// Get expiry info from a token (for display purposes)
function getTokenExpiry(token) {
  if (!token || typeof token !== 'string') return null;
  if (token.startsWith(TOKEN_PREFIX_V3)) {
    const rest = token.substring(TOKEN_PREFIX_V3.length);
    const firstDot = rest.indexOf('.');
    if (firstDot === -1) return null;
    const expiry = parseInt(rest.substring(0, firstDot), 10);
    if (isNaN(expiry) || expiry === 0) return null; // no expiry
    return expiry;
  }
  return null; // v2 has no expiry
}

// ---------- PIN hashing (PBKDF2) ----------

async function hashPin(pin, saltHex) {
  const enc = new TextEncoder();
  let salt;
  if (saltHex) {
    salt = hexToBytes(saltHex);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PIN_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );

  return {
    hash: bytesToHex(new Uint8Array(derived)),
    salt: bytesToHex(salt)
  };
}

async function verifyPin(pin, storedHash, storedSalt) {
  const result = await hashPin(pin, storedSalt);
  return result.hash === storedHash;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ---------- Exports ----------

globalThis.SessionShareCrypto = {
  OMNIBOX_KEYWORD,
  TOKEN_VERSION,
  TOKEN_PREFIX_V3,
  TOKEN_PREFIX_V2,
  encryptLocal,
  decryptLocal,
  encryptShared,
  decryptAny,
  getTokenExpiry,
  hashPin,
  verifyPin,
  rotateMasterKey,
  debugLog
};
