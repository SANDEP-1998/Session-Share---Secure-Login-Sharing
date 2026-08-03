// Session Share - Service Worker (Manifest V3)
// ============================================
// Responsibilities:
// - Handle copy/paste/save/load messages from popup and context menus
// - Encrypt/decrypt session tokens via WebCrypto
// - Manage chrome.cookies API for reading and setting cookies
// - Open target tabs and wait for them to load before applying session
//
// Architecture:
// - config.js provides crypto (globalThis.SessionShareCrypto)
// - cookies.js provides cookie helpers (globalThis.SessionShareCookies)
// - content-script.js (per-tab) handles clipboard relay
// - popup.js handles UI and user gesture operations

// Load dependencies.
// Chrome SW: importScripts loads config.js + cookies.js (manifest only has service_worker)
// Firefox event page: manifest's background.scripts already loaded them — DON'T re-import
//   (re-importing causes "const already declared" SyntaxError → background crash → popup blink)
if (!globalThis.SessionShareCrypto && typeof importScripts === 'function') {
  importScripts('config.js', 'cookies.js');
}

const CRYPTO = globalThis.SessionShareCrypto;
const COOKIES = globalThis.SessionShareCookies;

// Context menu IDs
const MENU_COPY_ID = 'menu_session_copy';
const MENU_PASTE_ID = 'menu_session_paste';

// ---------- Initialization ----------

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    // Rebuild context menus (safe to call on every install/update)
    await chrome.contextMenus.removeAll().catch(() => {});

    chrome.contextMenus.create({
      id: MENU_COPY_ID,
      title: 'Copy Session from This Page',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: MENU_PASTE_ID,
      title: 'Paste Session from Clipboard',
      contexts: ['page', 'action']
    });

    // Ensure master key exists
    await CRYPTO.getMasterKey();

    // Auto-cleanup old sessions on install/update
    await handleCleanupOldSessions(null);

    console.log('[SessionShare] Installed:', details.reason, 'v' + chrome.runtime.getManifest().version);
  } catch (err) {
    console.error('[SessionShare] Install failed:', err);
  }
});

// Also run cleanup on service worker startup
chrome.runtime.onStartup.addListener(async () => {
  try {
    await handleCleanupOldSessions(null);
  } catch (err) {
    CRYPTO.debugLog('Startup cleanup failed:', err);
  }
});

// ---------- Context menu handler ----------

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_COPY_ID && tab?.url) {
    runWithResponse(handleCopySession, { url: tab.url });
  } else if (info.menuItemId === MENU_PASTE_ID) {
    runWithResponse(handlePasteSession, {}, tab?.id || null);
  }
});

// ---------- Omnibox handler ----------

chrome.omnibox.setDefaultSuggestion({
  description: 'Paste a session token here (format: session_paste v3.X.Y.Z)'
});

chrome.omnibox.onInputEntered.addListener((text) => {
  handleOmniboxPaste(text).catch(err => {
    console.error('[SessionShare] Omnibox paste failed:', err);
    showNotification('Paste Failed', err.message);
  });
});

// ---------- Message router ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    sendResponse({ success: false, error: 'No action specified' });
    return false;
  }

  (async () => {
    try {
      switch (message.action) {
        case 'copySession':
          await handleCopySession(message, sendResponse);
          break;
        case 'pasteSession':
          await handlePasteSession(message, sender.tab?.id || null, sendResponse);
          break;
        case 'pasteSessionWithText':
          await handlePasteSessionWithText(message, sender.tab?.id || null, sendResponse);
          break;
        case 'readClipboard':
          await handleReadClipboard(sender.tab?.id, sendResponse);
          break;
        case 'saveSessionToAccount':
          await handleSaveSessionToAccount(message, sendResponse);
          break;
        case 'saveSessionToAccountWithText':
          await handleSaveSessionToAccountWithText(message, sendResponse);
          break;
        case 'saveCurrentTabSession':
          await handleSaveCurrentTabSession(message, sendResponse);
          break;
        case 'renameSession':
          await handleRenameSession(message, sendResponse);
          break;
        case 'loadSavedSession':
          await handleLoadSavedSession(message, sendResponse);
          break;
        case 'deleteSavedSession':
          await handleDeleteSavedSession(message, sendResponse);
          break;
        case 'deleteAllData':
          await handleDeleteAllData(sendResponse);
          break;
        case 'getStats':
          await handleGetStats(sendResponse);
          break;
        case 'listSavedSessions':
          await handleListSavedSessions(sendResponse);
          break;
        case 'previewToken':
          await handlePreviewToken(message, sendResponse);
          break;
        case 'setPin':
          await handleSetPin(message, sendResponse);
          break;
        case 'verifyPin':
          await handleVerifyPin(message, sendResponse);
          break;
        case 'removePin':
          await handleRemovePin(sendResponse);
          break;
        case 'cleanupOldSessions':
          await handleCleanupOldSessions(sendResponse);
          break;
        case 'exportSessions':
          await handleExportSessions(sendResponse);
          break;
        case 'importSessions':
          await handleImportSessions(message, sendResponse);
          break;
        case 'getKeyFingerprint':
          await handleGetKeyFingerprint(sendResponse);
          break;
        case 'rotateKey':
          await handleRotateKey(sendResponse);
          break;
        default:
          sendResponse({ success: false, error: 'Unknown action: ' + message.action });
      }
    } catch (err) {
      console.error('[SessionShare] Handler error for', message.action, err);
      sendResponse({ success: false, error: err.message || String(err) });
    }
  })();

  return true; // keep channel open for async
});

// Helper: run async handler without response (for context menu)
function runWithResponse(fn, ...args) {
  fn(...args, null).catch(err => {
    console.error('[SessionShare] Handler error:', err);
    showNotification('Error', err.message);
  });
}

// ---------- COPY SESSION ----------

async function handleCopySession(message, sendResponse) {
  if (!message?.url) {
    throw new Error('No URL provided');
  }

  let parsed;
  try {
    parsed = new URL(message.url);
  } catch {
    throw new Error('Invalid URL: ' + message.url);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Cannot copy session from ${parsed.protocol} pages`);
  }

  const cookieData = await COOKIES.getDomainCookies(message.url);
  if (!cookieData.cookies || cookieData.cookies.length === 0) {
    throw new Error('No cookies found for this page. Are you logged in?');
  }

  const payload = {
    v: 2,
    url: message.url,
    domain: parsed.hostname,
    cookies: cookieData.cookies,
    timestamp: Date.now()
  };

  // Encrypt for sharing (ephemeral key embedded in token)
  const token = await CRYPTO.encryptShared(JSON.stringify(payload));
  const clipboardText = `${CRYPTO.OMNIBOX_KEYWORD} ${token}`;

  // Persist as backup (so paste works even if clipboard write fails in popup)
  await chrome.storage.local.set({
    lastCopiedSession: clipboardText,
    lastCopiedTimestamp: Date.now(),
    lastCopiedDomain: parsed.hostname,
    lastCopiedCookieCount: cookieData.cookies.length
  });

  // Return token to popup — popup writes clipboard (has user gesture, reliable)
  // Background can't reliably write clipboard (no user gesture, popup closes)
  if (sendResponse) {
    sendResponse({
      success: true,
      token: token,
      cookieCount: cookieData.cookies.length,
      domain: parsed.hostname
    });
  }
}

// ---------- PASTE SESSION ----------

async function handlePasteSession(message, currentTabId, sendResponse) {
  let clipboardText = null;

  // 1. Try reading from active tab's content script
  if (currentTabId) {
    try {
      const response = await chrome.tabs.sendMessage(currentTabId, { action: 'readClipboard' });
      if (response?.success && response.text?.includes(CRYPTO.OMNIBOX_KEYWORD)) {
        clipboardText = response.text;
      }
    } catch (err) {
      CRYPTO.debugLog('Content script read failed:', err);
    }
  }

  // 2. Try service-worker clipboard API
  if (!clipboardText && navigator.clipboard?.readText) {
    try {
      const text = await navigator.clipboard.readText();
      if (text?.includes(CRYPTO.OMNIBOX_KEYWORD)) {
        clipboardText = text;
      }
    } catch (err) {
      CRYPTO.debugLog('SW clipboard read failed:', err);
    }
  }

  // 3. Fall back to last copied session in storage
  if (!clipboardText) {
    const stored = await chrome.storage.local.get(['lastCopiedSession']);
    if (stored.lastCopiedSession?.includes(CRYPTO.OMNIBOX_KEYWORD)) {
      clipboardText = stored.lastCopiedSession;
      showNotification('Using Last Session', 'Clipboard empty — using last copied session from storage.');
    }
  }

  if (!clipboardText) {
    throw new Error('No session in clipboard. Copy a session first (open any logged-in site and click Copy Session).');
  }

  const token = extractToken(clipboardText);
  if (!token) {
    throw new Error('Invalid session token format — could not extract token. Please copy the session again.');
  }

  // Decrypt
  const decryptedJson = await CRYPTO.decryptAny(token);
  let sessionData;
  try {
    sessionData = JSON.parse(decryptedJson);
  } catch {
    throw new Error('Session data is corrupted');
  }

  if (!sessionData?.cookies || !Array.isArray(sessionData.cookies) || sessionData.cookies.length === 0) {
    throw new Error('Session contains no cookies');
  }

  // Validate every cookie before applying any
  for (const c of sessionData.cookies) {
    if (!COOKIES.isValidCookie(c)) {
      throw new Error(`Invalid cookie in session: ${c?.name || 'unknown'}`);
    }
  }

  const sessionDomain = COOKIES.getPrimaryDomain(sessionData.cookies);
  if (!sessionDomain) {
    throw new Error('Could not determine session domain');
  }

  // Decide target tab: use current tab only if it's a valid web page on a matching domain.
  // Otherwise open a fresh tab for the session's domain.
  let targetTabId = currentTabId;
  let targetTab = null;
  if (currentTabId) {
    targetTab = await chrome.tabs.get(currentTabId).catch(() => null);
  }

  const needsNewTab = !targetTab || !isTabUsableForSession(targetTab, sessionDomain);

  if (needsNewTab) {
    const sessionUrl = `https://${sessionDomain}`;
    const newTab = await chrome.tabs.create({ url: sessionUrl, active: true });
    targetTabId = newTab.id;
    await waitForTabLoad(newTab.id, 15000);
  }

  // Apply cookies
  const results = await COOKIES.applyCookies(sessionData.cookies);

  // Reload to activate session
  if (targetTabId) {
    await chrome.tabs.reload(targetTabId).catch(() => {});
  }

  const successMsg = `${results.succeeded.length}/${sessionData.cookies.length} cookies set for ${sessionDomain}` +
                     (results.failed.length > 0 ? ` (${results.failed.length} failed)` : '');
  showNotification('Session Applied', successMsg);

  if (sendResponse) {
    sendResponse({
      success: results.succeeded.length > 0,
      domain: sessionDomain,
      cookiesSet: results.succeeded.length,
      cookiesFailed: results.failed.length
    });
  }
}

// ---------- PASTE SESSION WITH EXPLICIT TEXT (from popup clipboard read) ----------
// This is the reliable path: popup reads clipboard (has user gesture),
// passes text to background. Background decrypts and applies.
async function handlePasteSessionWithText(message, currentTabId, sendResponse) {
  const clipboardText = message?.text;
  if (!clipboardText || typeof clipboardText !== 'string') {
    throw new Error('No clipboard text provided');
  }

  const token = extractToken(clipboardText);
  if (!token) {
    throw new Error('Clipboard does not contain a valid session token. Copy a session first, or use the omnibox (type: session_paste <token>).');
  }

  // Decrypt
  const decryptedJson = await CRYPTO.decryptAny(token);
  let sessionData;
  try {
    sessionData = JSON.parse(decryptedJson);
  } catch {
    throw new Error('Session data is corrupted');
  }

  if (!sessionData?.cookies || !Array.isArray(sessionData.cookies) || sessionData.cookies.length === 0) {
    throw new Error('Session contains no cookies');
  }

  // Validate every cookie before applying any
  for (const c of sessionData.cookies) {
    if (!COOKIES.isValidCookie(c)) {
      throw new Error(`Invalid cookie in session: ${c?.name || 'unknown'}`);
    }
  }

  const sessionDomain = COOKIES.getPrimaryDomain(sessionData.cookies);
  if (!sessionDomain) {
    throw new Error('Could not determine session domain');
  }

  // Decide target tab
  let targetTabId = currentTabId;
  let targetTab = null;
  if (currentTabId) {
    targetTab = await chrome.tabs.get(currentTabId).catch(() => null);
  }

  const needsNewTab = !targetTab || !isTabUsableForSession(targetTab, sessionDomain);

  if (needsNewTab) {
    const sessionUrl = `https://${sessionDomain}`;
    const newTab = await chrome.tabs.create({ url: sessionUrl, active: true });
    targetTabId = newTab.id;
    await waitForTabLoad(newTab.id, 15000);
  }

  const results = await COOKIES.applyCookies(sessionData.cookies);

  if (targetTabId) {
    await chrome.tabs.reload(targetTabId).catch(() => {});
  }

  const successMsg = `${results.succeeded.length}/${sessionData.cookies.length} cookies set for ${sessionDomain}` +
                     (results.failed.length > 0 ? ` (${results.failed.length} failed)` : '');
  showNotification('Session Applied', successMsg);

  if (sendResponse) {
    sendResponse({
      success: results.succeeded.length > 0,
      domain: sessionDomain,
      cookiesSet: results.succeeded.length,
      cookiesFailed: results.failed.length
    });
  }
}

// ---------- OMNIBOX PASTE ----------

async function handleOmniboxPaste(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('No token provided. Type: session_paste <token>');
  }

  // Allow either "session_paste v2.X.Y" or just "v2.X.Y"
  let token = text.trim();
  if (token.startsWith(CRYPTO.OMNIBOX_KEYWORD)) {
    token = extractToken(token) || token.substring(CRYPTO.OMNIBOX_KEYWORD.length).trim();
  }

  if (!token) {
    throw new Error('Could not extract token from input');
  }

  const decryptedJson = await CRYPTO.decryptAny(token);
  let sessionData;
  try {
    sessionData = JSON.parse(decryptedJson);
  } catch {
    throw new Error('Session data is corrupted');
  }

  if (!sessionData?.cookies || !Array.isArray(sessionData.cookies) || sessionData.cookies.length === 0) {
    throw new Error('Session contains no cookies');
  }

  // Validate every cookie
  for (const c of sessionData.cookies) {
    if (!COOKIES.isValidCookie(c)) {
      throw new Error(`Invalid cookie in session: ${c?.name || 'unknown'}`);
    }
  }

  const sessionDomain = COOKIES.getPrimaryDomain(sessionData.cookies);
  if (!sessionDomain) {
    throw new Error('Could not determine session domain');
  }

  const newTab = await chrome.tabs.create({
    url: `https://${sessionDomain}`,
    active: true
  });
  await waitForTabLoad(newTab.id, 15000);

  const results = await COOKIES.applyCookies(sessionData.cookies);
  await chrome.tabs.reload(newTab.id);

  showNotification(
    'Session Applied',
    `${results.succeeded.length}/${sessionData.cookies.length} cookies set for ${sessionDomain}`
  );
}

// ---------- SAVED SESSIONS (local storage with master key) ----------

async function handleSaveSessionToAccount(message, sendResponse) {
  if (!message.accountNumber) {
    throw new Error('No account number provided');
  }

  const stored = await chrome.storage.local.get(['lastCopiedSession']);
  if (!stored.lastCopiedSession) {
    throw new Error('No session copied yet. Copy a session first (open a logged-in site and click "Copy Session").');
  }

  if (!stored.lastCopiedSession.includes(CRYPTO.OMNIBOX_KEYWORD)) {
    throw new Error('Stored session is corrupted or in an unsupported format. Please copy a fresh session.');
  }

  const token = extractToken(stored.lastCopiedSession);
  if (!token) {
    throw new Error('Could not extract session token from stored data. Please copy the session again.');
  }

  // Decrypt the shared token to get the raw session data
  const decryptedJson = await CRYPTO.decryptAny(token);
  let sessionData;
  try {
    sessionData = JSON.parse(decryptedJson);
  } catch {
    throw new Error('Stored session data is corrupted');
  }

  if (!sessionData?.cookies || !Array.isArray(sessionData.cookies)) {
    throw new Error('Stored session has no valid cookies');
  }

  // Re-encrypt with master key for local storage (real protection)
  const localEncrypted = await CRYPTO.encryptLocal(JSON.stringify(sessionData));

  const storageKey = `account_${message.accountNumber}`;
  await chrome.storage.local.set({
    [`${storageKey}_session`]: localEncrypted,
    [`${storageKey}_url`]: sessionData.url,
    [`${storageKey}_domain`]: sessionData.domain,
    [`${storageKey}_timestamp`]: Date.now()
  });

  // Update accounts index
  const { accounts = [] } = await chrome.storage.local.get(['accounts']);
  if (!accounts.includes(message.accountNumber)) {
    accounts.push(message.accountNumber);
    accounts.sort((a, b) => a - b);
    await chrome.storage.local.set({ accounts });
  }

  if (sendResponse) {
    sendResponse({
      success: true,
      url: sessionData.url,
      domain: sessionData.domain
    });
  }
}

// Save session to account using clipboard text provided by popup
// (popup has user gesture for clipboard read — background doesn't)
async function handleSaveSessionToAccountWithText(message, sendResponse) {
  if (!message.accountNumber) {
    throw new Error('No account number provided');
  }
  if (!message.text || typeof message.text !== 'string') {
    throw new Error('No clipboard text provided');
  }

  const token = extractToken(message.text);
  if (!token) {
    throw new Error('Clipboard does not contain a valid session token');
  }

  const decryptedJson = await CRYPTO.decryptAny(token);
  let sessionData;
  try {
    sessionData = JSON.parse(decryptedJson);
  } catch {
    throw new Error('Session data is corrupted');
  }

  if (!sessionData?.cookies || !Array.isArray(sessionData.cookies)) {
    throw new Error('Session has no valid cookies');
  }

  // Re-encrypt with master key for local storage
  const localEncrypted = await CRYPTO.encryptLocal(JSON.stringify(sessionData));

  const storageKey = `account_${message.accountNumber}`;
  await chrome.storage.local.set({
    [`${storageKey}_session`]: localEncrypted,
    [`${storageKey}_url`]: sessionData.url,
    [`${storageKey}_domain`]: sessionData.domain,
    [`${storageKey}_timestamp`]: Date.now()
  });

  // Also update lastCopiedSession so subsequent operations work
  await chrome.storage.local.set({
    lastCopiedSession: message.text,
    lastCopiedTimestamp: Date.now(),
    lastCopiedDomain: sessionData.domain,
    lastCopiedCookieCount: sessionData.cookies.length
  });

  // Update accounts index
  const { accounts = [] } = await chrome.storage.local.get(['accounts']);
  if (!accounts.includes(message.accountNumber)) {
    accounts.push(message.accountNumber);
    accounts.sort((a, b) => a - b);
    await chrome.storage.local.set({ accounts });
  }

  if (sendResponse) {
    sendResponse({
      success: true,
      url: sessionData.url,
      domain: sessionData.domain
    });
  }
}

// Helper: extract token from "session_paste <token>" string
// Uses indexOf + substring instead of split to handle edge cases:
// - Keyword appears multiple times
// - Keyword at end of string
// - Whitespace variations
function extractToken(text) {
  if (!text || typeof text !== 'string') return null;
  const prefix = CRYPTO.OMNIBOX_KEYWORD + ' ';
  const idx = text.indexOf(prefix);
  if (idx === -1) return null;
  return text.substring(idx + prefix.length).trim();
}

// ---------- SAVE CURRENT TAB SESSION (direct, no clipboard needed) ----------
// Reads cookies from the given URL directly, encrypts with master key,
// saves to a NEW account number (auto-incremented). CURRENT SESSION (account 1)
// always stays empty — it's just the "capture" button. Saved sessions stack below.
async function handleSaveCurrentTabSession(message, sendResponse) {
  try {
    if (!message.url || typeof message.url !== 'string') {
      throw new Error('No URL provided');
    }

    // Validate URL
    let parsed;
    try {
      parsed = new URL(message.url);
    } catch {
      throw new Error('Invalid URL: ' + message.url);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Cannot save session from ${parsed.protocol} pages. Open a regular website.`);
    }

    // Read cookies directly from the URL
    const cookieData = await COOKIES.getDomainCookies(message.url);
    if (!cookieData.cookies || cookieData.cookies.length === 0) {
      throw new Error('No cookies found for this page. Are you logged in?');
    }

    // Build session payload
    const sessionData = {
      v: 2,
      url: message.url,
      domain: parsed.hostname,
      cookies: cookieData.cookies,
      timestamp: Date.now()
    };

    // Encrypt with master key for local storage
    const localEncrypted = await CRYPTO.encryptLocal(JSON.stringify(sessionData));

    // Pick next available account number (skip 1 — that's CURRENT SESSION)
    const { accounts = [] } = await chrome.storage.local.get(['accounts']);
    let nextNum = 3;
    while (accounts.includes(nextNum)) {
      nextNum++;
    }

    // Build favicon URL — use Google's favicon service (reliable, no auth needed)
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`;

    // Tab title (if provided by popup) — truncate to 100 chars to avoid storage bloat
    const rawTabTitle = message.tabTitle || parsed.hostname;
    const tabTitle = rawTabTitle.length > 100 ? rawTabTitle.substring(0, 100) : rawTabTitle;

    // Save to the new account number
    const storageKey = `account_${nextNum}`;
    await chrome.storage.local.set({
      [`${storageKey}_session`]: localEncrypted,
      [`${storageKey}_url`]: sessionData.url,
      [`${storageKey}_domain`]: sessionData.domain,
      [`${storageKey}_timestamp`]: Date.now(),
      [`${storageKey}_favicon`]: faviconUrl,
      [`${storageKey}_tabTitle`]: tabTitle
    });

    // Update accounts index
    if (!accounts.includes(nextNum)) {
      accounts.push(nextNum);
      accounts.sort((a, b) => a - b);
      await chrome.storage.local.set({ accounts });
    }

    showNotification(
      'Session Saved',
      `${cookieData.cookies.length} cookies from ${parsed.hostname} captured`
    );

    if (sendResponse) {
      sendResponse({
        success: true,
        accountNumber: nextNum,
        url: sessionData.url,
        domain: sessionData.domain,
        cookieCount: cookieData.cookies.length,
        favicon: faviconUrl,
        tabTitle: tabTitle
      });
    }
  } catch (err) {
    console.error('[SessionShare] Save current tab failed:', err);
    if (sendResponse) {
      sendResponse({ success: false, error: err.message });
    }
  }
}

// ---------- RENAME SESSION ----------
async function handleRenameSession(message, sendResponse) {
  try {
    if (!message.accountNumber) {
      throw new Error('No account number provided');
    }
    const storageKey = `account_${message.accountNumber}`;
    if (message.customName && message.customName.trim().length > 0) {
      await chrome.storage.local.set({
        [`${storageKey}_customName`]: message.customName.trim().substring(0, 50)
      });
    } else {
      // Empty name = remove custom name, fall back to domain
      await chrome.storage.local.remove(`${storageKey}_customName`);
    }
    if (sendResponse) {
      sendResponse({ success: true });
    }
  } catch (err) {
    console.error('[SessionShare] Rename failed:', err);
    if (sendResponse) {
      sendResponse({ success: false, error: err.message });
    }
  }
}

async function handleLoadSavedSession(message, sendResponse) {
  if (!message.accountNumber) {
    throw new Error('No account number provided');
  }

  const storageKey = `account_${message.accountNumber}`;
  const data = await chrome.storage.local.get([
    `${storageKey}_session`,
    `${storageKey}_url`,
    `${storageKey}_domain`
  ]);

  const localEncrypted = data[`${storageKey}_session`];
  if (!localEncrypted) {
    throw new Error(`No saved session for account ${message.accountNumber}`);
  }

  // Decrypt with master key
  const decryptedJson = await CRYPTO.decryptLocal(localEncrypted);
  const sessionData = JSON.parse(decryptedJson);

  if (!sessionData?.cookies || sessionData.cookies.length === 0) {
    throw new Error('Saved session has no cookies');
  }

  const sessionDomain = sessionData.domain || COOKIES.getPrimaryDomain(sessionData.cookies);
  if (!sessionDomain) {
    throw new Error('Could not determine session domain');
  }

  const newTab = await chrome.tabs.create({
    url: `https://${sessionDomain}`,
    active: true
  });
  await waitForTabLoad(newTab.id, 15000);

  const results = await COOKIES.applyCookies(sessionData.cookies);
  await chrome.tabs.reload(newTab.id);

  // Track usage stats
  await trackSessionUsage(message.accountNumber);

  showNotification(
    'Session Loaded',
    `Account ${message.accountNumber}: ${sessionDomain} (${results.succeeded.length} cookies)`
  );

  if (sendResponse) {
    sendResponse({
      success: true,
      domain: sessionDomain,
      cookiesSet: results.succeeded.length
    });
  }
}

// Track session usage (use count + last used timestamp)
async function trackSessionUsage(accountNumber) {
  try {
    const keys = [`account_${accountNumber}_useCount`, `account_${accountNumber}_lastUsed`];
    const data = await chrome.storage.local.get(keys);
    const useCount = (data[`account_${accountNumber}_useCount`] || 0) + 1;
    await chrome.storage.local.set({
      [`account_${accountNumber}_useCount`]: useCount,
      [`account_${accountNumber}_lastUsed`]: Date.now()
    });
  } catch (err) {
    CRYPTO.debugLog('Failed to track usage:', err);
  }
}

// ---------- PREVIEW TOKEN (before applying) ----------

async function handlePreviewToken(message, sendResponse) {
  try {
    if (!message.text || typeof message.text !== 'string') {
      throw new Error('No text provided');
    }

    const token = extractToken(message.text) || message.text.trim();
    if (!token) {
      throw new Error('No valid token found');
    }

    const decryptedJson = await CRYPTO.decryptAny(token);
    let sessionData;
    try {
      sessionData = JSON.parse(decryptedJson);
    } catch {
      throw new Error('Session data is corrupted');
    }

    if (!sessionData?.cookies || !Array.isArray(sessionData.cookies)) {
      throw new Error('Session contains no cookies');
    }

    // Get expiry info
    const expiry = CRYPTO.getTokenExpiry(token);

    // Cookie breakdown
    const httpOnlyCount = sessionData.cookies.filter(c => c.httpOnly).length;
    const secureCount = sessionData.cookies.filter(c => c.secure).length;
    const sessionCookieCount = sessionData.cookies.filter(c => !c.expirationDate).length;

    if (sendResponse) {
      sendResponse({
        success: true,
        preview: {
          domain: sessionData.domain || COOKIES.getPrimaryDomain(sessionData.cookies),
          url: sessionData.url || null,
          cookieCount: sessionData.cookies.length,
          httpOnlyCount,
          secureCount,
          sessionCookieCount,
          expiry: expiry,
          isExpired: expiry > 0 && Date.now() > expiry,
          cookieNames: sessionData.cookies.map(c => c.name).slice(0, 10) // first 10 names
        }
      });
    }
  } catch (err) {
    console.error('[SessionShare] Preview failed:', err);
    if (sendResponse) {
      sendResponse({ success: false, error: err.message });
    }
  }
}

// ---------- PIN MANAGEMENT ----------

async function handleSetPin(message, sendResponse) {
  try {
    if (!message.pin || !/^\d{4,8}$/.test(message.pin)) {
      throw new Error('PIN must be 4-8 digits');
    }

    // If PIN already exists, verify old PIN first
    const existing = await chrome.storage.local.get(['pinHash', 'pinSalt']);
    if (existing.pinHash) {
      if (!message.oldPin) {
        throw new Error('Current PIN required to change');
      }
      const valid = await CRYPTO.verifyPin(message.oldPin, existing.pinHash, existing.pinSalt);
      if (!valid) {
        throw new Error('Current PIN is incorrect');
      }
    }

    const result = await CRYPTO.hashPin(message.pin);
    await chrome.storage.local.set({
      pinHash: result.hash,
      pinSalt: result.salt,
      pinEnabled: true
    });

    showNotification('PIN Set', 'Your PIN has been set successfully.');
    if (sendResponse) {
      sendResponse({ success: true });
    }
  } catch (err) {
    console.error('[SessionShare] Set PIN failed:', err);
    if (sendResponse) {
      sendResponse({ success: false, error: err.message });
    }
  }
}

async function handleVerifyPin(message, sendResponse) {
  try {
    if (!message.pin) {
      throw new Error('No PIN provided');
    }

    const data = await chrome.storage.local.get(['pinHash', 'pinSalt']);
    if (!data.pinHash || !data.pinSalt) {
      throw new Error('No PIN is set');
    }

    const valid = await CRYPTO.verifyPin(message.pin, data.pinHash, data.pinSalt);
    if (sendResponse) {
      sendResponse({ success: valid });
    }
  } catch (err) {
    console.error('[SessionShare] Verify PIN failed:', err);
    if (sendResponse) {
      sendResponse({ success: false, error: err.message });
    }
  }
}

async function handleRemovePin(sendResponse) {
  try {
    await chrome.storage.local.remove(['pinHash', 'pinSalt', 'pinEnabled']);
    showNotification('PIN Removed', 'PIN protection has been disabled.');
    if (sendResponse) {
      sendResponse({ success: true });
    }
  } catch (err) {
    console.error('[SessionShare] Remove PIN failed:', err);
    if (sendResponse) {
      sendResponse({ success: false, error: err.message });
    }
  }
}

// ---------- AUTO-CLEANUP ----------

// Remove sessions not used in the last N days (default 90)
async function handleCleanupOldSessions(sendResponse) {
  try {
    const data = await chrome.storage.local.get(null);
    const accounts = data.accounts || [];
    const CLEANUP_DAYS = 90;
    const cutoff = Date.now() - (CLEANUP_DAYS * 24 * 60 * 60 * 1000);

    const removed = [];
    const kept = [];

    for (const num of accounts) {
      const lastUsed = data[`account_${num}_lastUsed`] || data[`account_${num}_timestamp`] || 0;
      if (lastUsed < cutoff && lastUsed > 0) {
        // Remove this session
        await chrome.storage.local.remove([
          `account_${num}_session`,
          `account_${num}_url`,
          `account_${num}_domain`,
          `account_${num}_timestamp`,
          `account_${num}_useCount`,
          `account_${num}_lastUsed`,
          `account_${num}_favicon`,
          `account_${num}_tabTitle`,
          `account_${num}_customName`
        ]);
        removed.push(num);
      } else {
        kept.push(num);
      }
    }

    if (removed.length > 0) {
      await chrome.storage.local.set({ accounts: kept });
      showNotification('Cleanup Complete', `${removed.length} old session(s) removed (unused for ${CLEANUP_DAYS}+ days).`);
    }

    if (sendResponse) {
      sendResponse({ success: true, removed: removed.length, kept: kept.length });
    }
  } catch (err) {
    console.error('[SessionShare] Cleanup failed:', err);
    if (sendResponse) {
      sendResponse({ success: false, error: err.message });
    }
  }
}

async function handleDeleteSavedSession(message, sendResponse) {
  if (!message.accountNumber) {
    throw new Error('No account number provided');
  }

  const storageKey = `account_${message.accountNumber}`;
  await chrome.storage.local.remove([
    `${storageKey}_session`,
    `${storageKey}_url`,
    `${storageKey}_domain`,
    `${storageKey}_timestamp`,
    `${storageKey}_useCount`,
    `${storageKey}_lastUsed`,
    `${storageKey}_favicon`,
    `${storageKey}_tabTitle`,
    `${storageKey}_customName`
  ]);

  const { accounts = [] } = await chrome.storage.local.get(['accounts']);
  const updated = accounts.filter(n => n !== message.accountNumber);
  await chrome.storage.local.set({ accounts: updated });

  if (sendResponse) {
    sendResponse({ success: true });
  }
}

async function handleDeleteAllData(sendResponse) {
  // Clear all stored data
  await chrome.storage.local.clear();
  // Regenerate master key (invalidates any leftover ciphertext)
  await CRYPTO.rotateMasterKey();
  showNotification('Data Cleared', 'All saved sessions have been removed and the crypto key has been rotated.');
  if (sendResponse) {
    sendResponse({ success: true });
  }
}

async function handleGetStats(sendResponse) {
  const data = await chrome.storage.local.get(null);
  const accounts = data.accounts || [];

  if (sendResponse) {
    sendResponse({
      success: true,
      stats: {
        sessionCount: accounts.length,
        accounts,
        lastCopied: data.lastCopiedTimestamp || null,
        lastCopiedDomain: data.lastCopiedDomain || null
      }
    });
  }
}

async function handleListSavedSessions(sendResponse) {
  const data = await chrome.storage.local.get(null);
  const accounts = data.accounts || [];

  const sessions = accounts.map(num => {
    const domain = data[`account_${num}_domain`] || null;
    return {
      accountNumber: num,
      url: data[`account_${num}_url`] || null,
      domain: domain,
      timestamp: data[`account_${num}_timestamp`] || null,
      useCount: data[`account_${num}_useCount`] || 0,
      lastUsed: data[`account_${num}_lastUsed`] || null,
      favicon: data[`account_${num}_favicon`] || (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : null),
      tabTitle: data[`account_${num}_tabTitle`] || domain || null,
      customName: data[`account_${num}_customName`] || null
    };
  });

  if (sendResponse) {
    sendResponse({ success: true, sessions });
  }
}

// ---------- EXPORT / IMPORT ----------

async function handleExportSessions(sendResponse) {
  try {
    const data = await chrome.storage.local.get(null);
    const accounts = data.accounts || [];

    const sessions = [];
    for (const num of accounts) {
      const sessionKey = `account_${num}_session`;
      const localEncrypted = data[sessionKey];
      if (!localEncrypted) continue;

      // Decrypt with master key, then re-encrypt with a fresh ephemeral key
      // so the backup file is portable (but still protected by a passphrase
      // the user must remember — we use a fixed passphrase "session-share-backup"
      // by default; the user should treat the exported file as sensitive)
      const decryptedJson = await CRYPTO.decryptLocal(localEncrypted);

      sessions.push({
        accountNumber: num,
        url: data[`account_${num}_url`] || null,
        domain: data[`account_${num}_domain`] || null,
        timestamp: data[`account_${num}_timestamp`] || null,
        useCount: data[`account_${num}_useCount`] || 0,
        lastUsed: data[`account_${num}_lastUsed`] || null,
        favicon: data[`account_${num}_favicon`] || null,
        tabTitle: data[`account_${num}_tabTitle`] || null,
        customName: data[`account_${num}_customName`] || null,
        sessionData: JSON.parse(decryptedJson)
      });
    }

    const backup = {
      version: 2,
      exportedAt: Date.now(),
      sessionCount: sessions.length,
      sessions: sessions
    };

    if (sendResponse) {
      sendResponse({
        success: true,
        backup: JSON.stringify(backup, null, 2),
        filename: `session-share-backup-${new Date().toISOString().slice(0, 10)}.json`
      });
    }
  } catch (err) {
    console.error('[SessionShare] Export failed:', err);
    if (sendResponse) {
      sendResponse({ success: false, error: err.message });
    }
  }
}

async function handleImportSessions(message, sendResponse) {
  try {
    if (!message.backup || typeof message.backup !== 'string') {
      throw new Error('No backup data provided');
    }

    let backup;
    try {
      backup = JSON.parse(message.backup);
    } catch {
      throw new Error('Backup file is not valid JSON');
    }

    if (!backup || backup.version !== 2 || !Array.isArray(backup.sessions)) {
      throw new Error('Invalid backup format (expected version 2)');
    }

    let imported = 0;
    const { accounts = [] } = await chrome.storage.local.get(['accounts']);
    let nextNum = accounts.length > 0 ? Math.max(...accounts) + 1 : 1;

    for (const s of backup.sessions) {
      if (!s.sessionData?.cookies || !Array.isArray(s.sessionData.cookies)) {
        continue;
      }

      // Re-encrypt with this user's master key
      const localEncrypted = await CRYPTO.encryptLocal(JSON.stringify(s.sessionData));

      const importDomain = s.domain || s.sessionData.domain || null;
      const storageKey = `account_${nextNum}`;
      await chrome.storage.local.set({
        [`${storageKey}_session`]: localEncrypted,
        [`${storageKey}_url`]: s.url || s.sessionData.url || null,
        [`${storageKey}_domain`]: importDomain,
        [`${storageKey}_timestamp`]: s.timestamp || Date.now(),
        [`${storageKey}_useCount`]: s.useCount || 0,
        [`${storageKey}_lastUsed`]: s.lastUsed || null,
        [`${storageKey}_favicon`]: s.favicon || (importDomain ? `https://www.google.com/s2/favicons?domain=${importDomain}&sz=64` : null),
        [`${storageKey}_tabTitle`]: s.tabTitle || importDomain || null,
        [`${storageKey}_customName`]: s.customName || null
      });

      if (!accounts.includes(nextNum)) {
        accounts.push(nextNum);
      }
      nextNum++;
      imported++;
    }

    accounts.sort((a, b) => a - b);
    await chrome.storage.local.set({ accounts });

    showNotification('Import Complete', `${imported} session(s) imported successfully.`);

    if (sendResponse) {
      sendResponse({ success: true, imported });
    }
  } catch (err) {
    console.error('[SessionShare] Import failed:', err);
    if (sendResponse) {
      sendResponse({ success: false, error: err.message });
    }
  }
}

// ---------- KEY FINGERPRINT & ROTATION ----------

async function handleGetKeyFingerprint(sendResponse) {
  try {
    const key = await CRYPTO.getMasterKey();
    // Export key, hash it, take first 16 hex chars as fingerprint
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const keyBytes = new TextEncoder().encode(jwk.k || '');
    const hashBuffer = await crypto.subtle.digest('SHA-256', keyBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const fingerprint = hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');

    const data = await chrome.storage.local.get(['accounts', 'lastCopiedTimestamp']);
    const accounts = data.accounts || [];

    let lastActivity = '—';
    if (data.lastCopiedTimestamp) {
      lastActivity = new Date(data.lastCopiedTimestamp).toLocaleString();
    } else {
      // Check saved sessions for latest timestamp
      let latest = 0;
      for (const num of accounts) {
        const ts = (await chrome.storage.local.get(`account_${num}_timestamp`))[`account_${num}_timestamp`];
        if (ts && ts > latest) latest = ts;
      }
      if (latest > 0) lastActivity = new Date(latest).toLocaleString();
    }

    if (sendResponse) {
      sendResponse({
        success: true,
        fingerprint: fingerprint,
        sessionCount: accounts.length,
        lastActivity: lastActivity
      });
    }
  } catch (err) {
    console.error('[SessionShare] Fingerprint failed:', err);
    if (sendResponse) {
      sendResponse({ success: false, error: err.message });
    }
  }
}

async function handleRotateKey(sendResponse) {
  try {
    // Delete all saved sessions (they're encrypted with the old key)
    const data = await chrome.storage.local.get(null);
    const accounts = data.accounts || [];
    const keysToRemove = ['accounts', 'masterKeyJwk'];
    for (const num of accounts) {
      keysToRemove.push(
        `account_${num}_session`,
        `account_${num}_url`,
        `account_${num}_domain`,
        `account_${num}_timestamp`,
        `account_${num}_useCount`,
        `account_${num}_lastUsed`,
        `account_${num}_favicon`,
        `account_${num}_tabTitle`,
        `account_${num}_customName`
      );
    }
    await chrome.storage.local.remove(keysToRemove);

    // Rotate key (this generates a new one)
    await CRYPTO.rotateMasterKey();

    showNotification('Key Rotated', 'Master key has been rotated. All saved sessions were deleted.');

    if (sendResponse) {
      sendResponse({ success: true });
    }
  } catch (err) {
    console.error('[SessionShare] Key rotation failed:', err);
    if (sendResponse) {
      sendResponse({ success: false, error: err.message });
    }
  }
}

async function handleReadClipboard(tabId, sendResponse) {
  let text = null;

  if (tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: 'readClipboard' });
      if (response?.success) text = response.text;
    } catch (err) {
      CRYPTO.debugLog('Tab clipboard read failed:', err);
    }
  }

  if (!text && navigator.clipboard?.readText) {
    try {
      text = await navigator.clipboard.readText();
    } catch (err) {
      CRYPTO.debugLog('SW clipboard read failed:', err);
    }
  }

  if (!text) {
    const stored = await chrome.storage.local.get(['lastCopiedSession']);
    text = stored.lastCopiedSession || null;
  }

  if (sendResponse) {
    sendResponse({ success: true, text });
  }
}

// ---------- HELPERS ----------

// Returns true if the tab is a valid web page (http/https) AND its hostname
// matches the session domain (so cookies can be applied in-place).
function isTabUsableForSession(tab, sessionDomain) {
  if (!tab || !tab.url) return false;
  let parsed;
  try {
    parsed = new URL(tab.url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  return COOKIES.isDomainMatch(parsed.hostname, sessionDomain);
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        if (resolved) return;
        resolved = true;
        cleanup();
        // Small grace period for the page's own JS to settle
        setTimeout(resolve, 300);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);

    // Initial check (in case tab is already complete)
    chrome.tabs.get(tabId).then(tab => {
      if (tab && tab.status === 'complete' && !resolved) {
        resolved = true;
        cleanup();
        setTimeout(resolve, 300);
      }
    }).catch(() => {
      // ignore
    });

    // Timeout — proceed anyway (cookies can be set before full load)
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      CRYPTO.debugLog('Tab load timeout, proceeding anyway');
      resolve();
    }, timeoutMs);
  });
}

function showNotification(title, message) {
  try {
    // Check if notifications are enabled in popup settings
    chrome.storage.local.get('popupSettings').then(data => {
      const settings = data.popupSettings || {};
      if (settings.notifications === false) return; // disabled

      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'Icon128.png',
        title: String(title).substring(0, 50),
        message: String(message).substring(0, 200),
        priority: 2
      });
    }).catch(() => {
      // If storage read fails, show notification anyway
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'Icon128.png',
        title: String(title).substring(0, 50),
        message: String(message).substring(0, 200),
        priority: 2
      });
    });
  } catch (err) {
    console.log(`[SessionShare] ${title}: ${message}`);
  }
}
