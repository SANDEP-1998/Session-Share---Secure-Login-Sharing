// Session Share - Popup script
// ============================================
// Vanilla JS, no jQuery, no underscore.
// Fixed bugs from original:
// - Removed fake `isPro = true`, `isPremiumUser = true` hardcoded premium bypass
// - Defined all helper functions (no more undefined showLoadingUI / showSuccess / nextAccountNumber)
// - Fixed `scott128.png` typo -> `Icon128.png` (handled in background, not here)
// - Proper async/await with error boundaries
// - Proper button state management (disabled + loading text)

(function () {
  'use strict';

  // ---------- Constants ----------
  const OMNIBOX_KEYWORD = (window.SessionShareCrypto || { OMNIBOX_KEYWORD: 'session_paste' }).OMNIBOX_KEYWORD;

  // ---------- State ----------
  let isBusy = false;
  let allSessions = []; // cached for search filter
  let settings = {
    darkMode: false,
    autoClose: true,
    notifications: true
  };
  let isLocked = false;
  let sortMode = 'recent'; // recent, oldest, domain-az, domain-za, most-used
  let pendingPasteText = null; // for preview-then-apply flow

  // ---------- DOM refs ----------
  const $ = (id) => document.getElementById(id);
  const accountsList = $('accounts-list');
  const currentSessionList = $('current-session-list');
  const statsText = $('stats-text');
  const toastEl = $('toast');

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      // Load settings first (for dark mode before render)
      await loadSettings();
      applySettings();

      // Check if PIN is enabled
      await checkPinLock();

      // Wire up all event listeners
      $('btn-copy').addEventListener('click', onCopyClick);
      $('btn-paste').addEventListener('click', onPasteClick);
      $('btn-clear-all').addEventListener('click', onClearAll);

      // Search
      $('btn-search').addEventListener('click', toggleSearch);
      $('search-input').addEventListener('input', onSearchInput);
      $('clear-search').addEventListener('click', clearSearch);

      // Sort
      $('sort-select').addEventListener('change', (e) => {
        sortMode = e.target.value;
        refreshAccountList();
      });

      // Header modals
      $('btn-settings').addEventListener('click', openSettingsModal);
      $('btn-security').addEventListener('click', openSecurityModal);
      $('settings-close').addEventListener('click', () => closeModalById('settings-modal'));
      $('security-close').addEventListener('click', () => closeModalById('security-modal'));
      $('share-close').addEventListener('click', () => closeModalById('share-modal'));

      // Settings toggles
      $('setting-dark-mode').addEventListener('change', (e) => {
        settings.darkMode = e.target.checked;
        saveSettings();
        applySettings();
      });
      $('setting-autoclose').addEventListener('change', (e) => {
        settings.autoClose = e.target.checked;
        saveSettings();
      });
      $('setting-notifications').addEventListener('change', (e) => {
        settings.notifications = e.target.checked;
        saveSettings();
      });

      // Export / Import
      $('setting-export').addEventListener('click', onExportSessions);
      $('setting-import').addEventListener('click', () => $('import-file-input').click());
      $('import-file-input').addEventListener('change', onImportFileSelected);

      // PIN management
      $('setting-pin').addEventListener('click', onManagePin);
      $('setting-cleanup').addEventListener('click', onCleanup);

      // Rotate key
      $('setting-rotate-key').addEventListener('click', onRotateKey);

      // Share modal buttons
      $('share-copy').addEventListener('click', () => onShareAction('copy'));
      $('share-whatsapp').addEventListener('click', () => onShareAction('whatsapp'));
      $('share-telegram').addEventListener('click', () => onShareAction('telegram'));
      $('share-qr').addEventListener('click', () => onShareAction('qr'));

      // Preview modal
      $('preview-cancel').addEventListener('click', () => closeModalId('preview-modal'));
      $('preview-apply').addEventListener('click', () => {
        closeModalId('preview-modal');
        if (pendingPasteText) {
          applyPasteWithText(pendingPasteText);
          pendingPasteText = null;
        }
      });

      // Manual paste modal (cross-browser fallback)
      $('manual-paste-cancel').addEventListener('click', () => closeModalById('manual-paste-modal'));
      $('manual-paste-apply').addEventListener('click', onManualPasteApply);

      // PIN lock
      $('pin-unlock').addEventListener('click', onPinUnlock);
      $('pin-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') onPinUnlock();
      });
      $('pin-input').addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/[^0-9]/g, '');
        $('pin-error').textContent = '';
      });

      // Confirm modal
      $('modal-cancel').addEventListener('click', closeModal);
      $('modal-confirm').addEventListener('click', () => {
        if (currentConfirm?.onConfirm) currentConfirm.onConfirm();
        closeModal();
      });

      // Close modal on backdrop click
      document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
        if (backdrop.id === 'pin-lock-modal') return; // don't close lock on backdrop
        backdrop.addEventListener('click', (e) => {
          if (e.target === backdrop) {
            backdrop.classList.remove('active');
          }
        });
      });

      // Keyboard shortcuts
      document.addEventListener('keydown', onKeyDown);

      await refreshAccountList();
      await updateStats();
    } catch (err) {
      console.error('[SessionShare] Init failed:', err);
      showToast('Failed to initialize: ' + err.message, 'error');
    }
  }

  // ---------- PIN Lock ----------
  async function checkPinLock() {
    try {
      const data = await chrome.storage.local.get(['pinEnabled', 'pinHash']);
      if (data.pinEnabled && data.pinHash) {
        isLocked = true;
        $('pin-lock-modal').classList.add('active');
        $('pin-lock-modal').style.display = 'flex';
        setTimeout(() => $('pin-input').focus(), 100);
      }
    } catch (err) {
      console.warn('[SessionShare] PIN check failed:', err);
    }
  }

  async function onPinUnlock() {
    const pin = $('pin-input').value;
    if (!pin) {
      $('pin-error').textContent = 'Please enter your PIN';
      return;
    }
    try {
      const response = await sendMessage({ action: 'verifyPin', pin });
      if (response?.success) {
        isLocked = false;
        $('pin-lock-modal').classList.remove('active');
        $('pin-lock-modal').style.display = 'none';
        $('pin-input').value = '';
        $('pin-error').textContent = '';
        showToast('Unlocked', 'success');
      } else {
        $('pin-error').textContent = 'Incorrect PIN';
        $('pin-input').value = '';
        $('pin-input').focus();
        // Shake animation
        const input = $('pin-input');
        input.style.animation = 'none';
        setTimeout(() => {
          input.style.animation = 'shake 0.3s ease';
        }, 10);
      }
    } catch (err) {
      $('pin-error').textContent = err.message || 'Verification failed';
    }
  }

  async function onManagePin() {
    try {
      // Check if PIN is already set
      const data = await chrome.storage.local.get(['pinEnabled', 'pinHash']);
      if (data.pinEnabled && data.pinHash) {
        // PIN exists — offer to change or remove
        const action = await showChoice(
          'PIN Protection',
          'PIN is currently enabled. What would you like to do?',
          ['Change PIN', 'Remove PIN', 'Cancel']
        );
        if (action === 'Change PIN') {
          await setPinFlow(true);
        } else if (action === 'Remove PIN') {
          const response = await sendMessage({ action: 'removePin' });
          if (response?.success) {
            showToast('PIN removed', 'success');
            updatePinButton();
          } else {
            showToast(response?.error || 'Failed to remove PIN', 'error');
          }
        }
      } else {
        // No PIN — set one
        await setPinFlow(false);
      }
    } catch (err) {
      console.error('[SessionShare] Manage PIN failed:', err);
      showToast(err.message || 'PIN operation failed', 'error');
    }
  }

  async function setPinFlow(isChange) {
    const title = isChange ? 'Change PIN' : 'Set PIN';
    const pin = prompt(title + ' — Enter a 4-8 digit PIN:');
    if (!pin) return;
    if (!/^\d{4,8}$/.test(pin)) {
      showToast('PIN must be 4-8 digits', 'error');
      return;
    }
    const confirmPin = prompt(title + ' — Confirm your PIN:');
    if (pin !== confirmPin) {
      showToast('PINs do not match', 'error');
      return;
    }

    let oldPin = null;
    if (isChange) {
      oldPin = prompt(title + ' — Enter your CURRENT PIN:');
      if (!oldPin) return;
    }

    try {
      const response = await sendMessage({ action: 'setPin', pin, oldPin });
      if (response?.success) {
        showToast(isChange ? 'PIN changed' : 'PIN set', 'success');
        updatePinButton();
      } else {
        showToast(response?.error || 'Failed to set PIN', 'error');
      }
    } catch (err) {
      console.error('[SessionShare] Set PIN failed:', err);
      showToast(err.message || 'Failed to set PIN', 'error');
    }
  }

  async function updatePinButton() {
    try {
      const data = await chrome.storage.local.get(['pinEnabled', 'pinHash']);
      const btn = $('setting-pin');
      const desc = $('pin-status-desc');
      if (!btn || !desc) return;
      if (data.pinEnabled && data.pinHash) {
        btn.textContent = 'Manage';
        btn.classList.remove('primary');
        btn.classList.add('danger');
        desc.textContent = 'PIN is enabled. Click to change or remove.';
      } else {
        btn.textContent = 'Set PIN';
        btn.classList.add('primary');
        btn.classList.remove('danger');
        desc.textContent = 'Lock the extension with a 4-8 digit PIN';
      }
    } catch (err) {
      console.warn('[SessionShare] updatePinButton failed:', err);
    }
  }

  async function onCleanup() {
    showConfirm(
      'Cleanup Old Sessions',
      'This will remove all saved sessions that have not been used in the last 90 days. Continue?',
      async () => {
        try {
          const response = await sendMessage({ action: 'cleanupOldSessions' });
          if (!response?.success) {
            throw new Error(response?.error || 'Cleanup failed');
          }
          showToast(`Removed ${response.removed} old session(s)`, 'success');
          await refreshAccountList();
          await updateStats();
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    );
  }

  // ---------- Keyboard shortcuts ----------
  function onKeyDown(e) {
    if (isLocked) return;
    // Esc closes any open modal
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop.active').forEach(m => {
        if (m.id !== 'pin-lock-modal') m.classList.remove('active');
      });
      return;
    }
    // Ctrl+Shift+C = copy
    if (e.ctrlKey && e.shiftKey && e.key === 'C') {
      e.preventDefault();
      onCopyClick();
    }
    // Ctrl+Shift+V = paste
    if (e.ctrlKey && e.shiftKey && e.key === 'V') {
      e.preventDefault();
      onPasteClick();
    }
  }

  // ---------- Choice dialog (uses confirm modal with custom buttons) ----------
  function showChoice(title, message, options) {
    return new Promise((resolve) => {
      $('modal-title').textContent = title;
      $('modal-message').textContent = message;
      const actions = document.querySelector('#confirm-modal .modal-actions');

      // Hide original buttons instead of replacing innerHTML (preserves listeners)
      const originalButtons = Array.from(actions.children);
      originalButtons.forEach(btn => btn.style.display = 'none');

      // Create choice buttons
      const choiceButtons = [];
      for (const opt of options) {
        const btn = document.createElement('button');
        btn.textContent = opt;
        btn.className = opt === 'Cancel' ? 'btn-secondary' : 'btn-danger';
        if (opt !== 'Cancel' && opt !== 'Remove PIN') {
          btn.style.background = '#06B6D4';
        }
        btn.addEventListener('click', () => {
          // Clean up choice buttons
          choiceButtons.forEach(b => b.remove());
          // Restore original buttons
          originalButtons.forEach(b => b.style.display = '');
          closeModal();
          resolve(opt);
        });
        actions.appendChild(btn);
        choiceButtons.push(btn);
      }

      // Handle Escape/backdrop: resolve with 'Cancel' if present, else last option
      const escapeHandler = (e) => {
        if (e.key === 'Escape') {
          choiceButtons.forEach(b => b.remove());
          originalButtons.forEach(b => b.style.display = '');
          closeModal();
          document.removeEventListener('keydown', escapeHandler);
          const cancelOpt = options.includes('Cancel') ? 'Cancel' : options[options.length - 1];
          resolve(cancelOpt);
        }
      };
      document.addEventListener('keydown', escapeHandler, { once: true });

      // Backdrop click handler
      const backdrop = $('confirm-modal');
      const backdropHandler = (e) => {
        if (e.target === backdrop) {
          choiceButtons.forEach(b => b.remove());
          originalButtons.forEach(b => b.style.display = '');
          document.removeEventListener('keydown', escapeHandler);
          backdrop.removeEventListener('click', backdropHandler);
          const cancelOpt = options.includes('Cancel') ? 'Cancel' : options[options.length - 1];
          resolve(cancelOpt);
        }
      };
      backdrop.addEventListener('click', backdropHandler);

      $('confirm-modal').classList.add('active');
    });
  }

  function closeModalId(id) {
    $(id).classList.remove('active');
  }

  // ---------- Settings persistence ----------
  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get('popupSettings');
      if (data.popupSettings) {
        settings = { ...settings, ...data.popupSettings };
      }
    } catch (err) {
      console.warn('[SessionShare] Failed to load settings:', err);
    }
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({ popupSettings: settings });
    } catch (err) {
      console.warn('[SessionShare] Failed to save settings:', err);
    }
  }

  function applySettings() {
    // Dark mode
    if (settings.darkMode) {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
    // Sync toggles
    const dm = $('setting-dark-mode');
    const ac = $('setting-autoclose');
    const nt = $('setting-notifications');
    if (dm) dm.checked = settings.darkMode;
    if (ac) ac.checked = settings.autoClose;
    if (nt) nt.checked = settings.notifications;
  }

  // ---------- Search ----------
  function toggleSearch() {
    const searchBar = $('search-bar');
    const isVisible = searchBar.classList.toggle('visible');
    if (isVisible) {
      $('search-input').focus();
    } else {
      clearSearch();
    }
  }

  function onSearchInput(e) {
    const query = e.target.value.toLowerCase().trim();
    filterAccounts(query);
  }

  function clearSearch() {
    $('search-input').value = '';
    filterAccounts('');
  }

  function filterAccounts(query) {
    // CURRENT SESSION always stays at top (not filtered)
    currentSessionList.innerHTML = '';
    renderEmptySlotInto(currentSessionList, 1);

    if (!query) {
      // Re-render saved sessions from cache (no async call needed)
      accountsList.innerHTML = '';
      if (allSessions.length === 0) {
        const emptyHint = $('empty-hint');
        if (emptyHint) emptyHint.style.display = 'block';
        return;
      }
      const emptyHint = $('empty-hint');
      if (emptyHint) emptyHint.style.display = 'none';
      const sortBar = $('sort-bar');
      if (sortBar) sortBar.style.display = allSessions.length > 1 ? 'flex' : 'none';
      const sorted = sortSessions(allSessions);
      for (const s of sorted) {
        renderSessionCard(s);
      }
      return;
    }
    // Filter from cached allSessions — search by domain, url, customName, tabTitle
    accountsList.innerHTML = '';
    const sortBar = $('sort-bar');
    if (sortBar) sortBar.style.display = 'none';
    const filtered = allSessions.filter(s => {
      const domain = (s.domain || '').toLowerCase();
      const url = (s.url || '').toLowerCase();
      const customName = (s.customName || '').toLowerCase();
      const tabTitle = (s.tabTitle || '').toLowerCase();
      return domain.includes(query) || url.includes(query) ||
             customName.includes(query) || tabTitle.includes(query);
    });
    if (filtered.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent = 'No sessions match your search.';
      accountsList.appendChild(hint);
      return;
    }
    for (const s of filtered) {
      renderSessionCard(s);
    }
  }

  // ---------- Settings modal ----------
  function openSettingsModal() {
    applySettings(); // sync toggle states
    updatePinButton(); // update PIN button state
    $('settings-modal').classList.add('active');
  }

  // ---------- Security modal ----------
  async function openSecurityModal() {
    $('security-modal').classList.add('active');
    // Load fingerprint data
    $('key-fingerprint').textContent = 'Loading...';
    $('sec-session-count').textContent = '...';
    $('sec-last-activity').textContent = '...';
    try {
      const response = await sendMessage({ action: 'getKeyFingerprint' });
      if (response?.success) {
        $('key-fingerprint').textContent = response.fingerprint;
        $('sec-session-count').textContent = response.sessionCount;
        $('sec-last-activity').textContent = response.lastActivity;
      } else {
        $('key-fingerprint').textContent = 'Error';
      }
    } catch (err) {
      $('key-fingerprint').textContent = 'Error';
    }
  }

  // ---------- Share modal ----------
  let currentShareAccount = null;

  async function onShareAccount(accountNumber) {
    if (isBusy) return;
    currentShareAccount = accountNumber;
    // Reset QR display
    $('qr-display').style.display = 'none';
    $('share-expiry').value = '0'; // default: no expiry
    // Load domain for subtitle
    try {
      const data = await chrome.storage.local.get(`account_${accountNumber}_domain`);
      const domain = data[`account_${accountNumber}_domain`];
      $('share-domain').textContent = domain
        ? `Share session for ${domain}`
        : 'Choose how you want to share';
    } catch {
      $('share-domain').textContent = 'Choose how you want to share';
    }
    $('share-modal').classList.add('active');
  }

  async function onShareAction(channel) {
    if (!currentShareAccount) return;
    try {
      const storageKey = `account_${currentShareAccount}_session`;
      const data = await chrome.storage.local.get(storageKey);
      const localEncrypted = data[storageKey];
      if (!localEncrypted) {
        throw new Error('No saved session for this account');
      }

      // Get expiry hours from selector
      const expiryHours = parseInt($('share-expiry').value, 10) || 0;

      // Decrypt with master key, re-encrypt as shared token (with optional expiry)
      const decryptedJson = await window.SessionShareCrypto.decryptLocal(localEncrypted);
      const sharedToken = await window.SessionShareCrypto.encryptShared(decryptedJson, expiryHours);
      const clipboardText = `${OMNIBOX_KEYWORD} ${sharedToken}`;

      if (channel === 'copy') {
        await copyTextToClipboard(clipboardText);
        const expiryMsg = expiryHours > 0 ? ` (expires in ${expiryHours}h)` : '';
        showToast('Token copied to clipboard' + expiryMsg, 'success');
        closeModalById('share-modal');
      } else if (channel === 'whatsapp') {
        const url = `https://wa.me/?text=${encodeURIComponent(clipboardText)}`;
        await chrome.tabs.create({ url, active: true });
        showToast('Opening WhatsApp...', 'success');
        closeModalById('share-modal');
        if (settings.autoClose) setTimeout(() => window.close(), 800);
      } else if (channel === 'telegram') {
        const url = `https://t.me/share/url?url=${encodeURIComponent(clipboardText)}`;
        await chrome.tabs.create({ url, active: true });
        showToast('Opening Telegram...', 'success');
        closeModalById('share-modal');
        if (settings.autoClose) setTimeout(() => window.close(), 800);
      } else if (channel === 'qr') {
        // Generate QR code via api.qrserver.com
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(clipboardText)}`;
        $('qr-image').src = qrUrl;
        $('qr-display').style.display = 'block';
        showToast('QR code generated', 'success');
      }
    } catch (err) {
      console.error('[SessionShare] Share failed:', err);
      showToast(err.message, 'error');
    }
  }

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      console.warn('[SessionShare] navigator.clipboard failed, falling back:', err);
    }
    // Fallback: hidden textarea
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!ok) throw new Error('Clipboard write failed');
    return true;
  }

  // ---------- Export / Import ----------
  async function onExportSessions() {
    try {
      showToast('Preparing export...', 'success');
      const response = await sendMessage({ action: 'exportSessions' });
      if (!response?.success) {
        throw new Error(response?.error || 'Export failed');
      }
      // Trigger download via blob URL
      const blob = new Blob([response.backup], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = response.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`Exported ${JSON.parse(response.backup).sessionCount} session(s)`, 'success');
    } catch (err) {
      console.error('[SessionShare] Export failed:', err);
      showToast(err.message, 'error');
    }
  }

  function onImportFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const backupText = event.target.result;
        const response = await sendMessage({
          action: 'importSessions',
          backup: backupText
        });
        if (!response?.success) {
          throw new Error(response?.error || 'Import failed');
        }
        showToast(`Imported ${response.imported} session(s)`, 'success');
        await refreshAccountList();
        await updateStats();
      } catch (err) {
        console.error('[SessionShare] Import failed:', err);
        showToast(err.message, 'error');
      } finally {
        // Reset input so same file can be re-selected
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  }

  async function onRotateKey() {
    showConfirm(
      'Rotate Master Key',
      'WARNING: This will permanently delete ALL your saved sessions and generate a new encryption key. This cannot be undone. Continue?',
      async () => {
        try {
          const response = await sendMessage({ action: 'rotateKey' });
          if (!response?.success) {
            throw new Error(response?.error || 'Rotation failed');
          }
          showToast('Master key rotated', 'success');
          closeModalById('security-modal');
          await refreshAccountList();
          await updateStats();
          openSecurityModal(); // refresh fingerprint
        } catch (err) {
          console.error('[SessionShare] Rotate failed:', err);
          showToast(err.message, 'error');
        }
      }
    );
  }

  function closeModalById(id) {
    $(id).classList.remove('active');
  }

  // ---------- Copy / Paste ----------

  async function onCopyClick() {
    if (isBusy) return;
    setBusy(true, $('btn-copy'), 'Copying...');

    try {
      const tab = await getActiveTab();
      if (!tab || !tab.url) {
        throw new Error('No active tab found. Open a website first.');
      }

      // Step 1: Get encrypted token from background (fast — just reads cookies + encrypts)
      const response = await sendMessage({ action: 'copySession', url: tab.url });
      if (!response?.success) {
        throw new Error(response?.error || 'Copy failed');
      }

      // Step 2: Write to clipboard IN POPUP (has user gesture — most reliable)
      // Background can't reliably write clipboard (no user gesture, popup may close)
      const clipboardText = `${OMNIBOX_KEYWORD} ${response.token}`;
      let copied = false;
      try {
        await navigator.clipboard.writeText(clipboardText);
        copied = true;
      } catch (err) {
        console.warn('[SessionShare] navigator.clipboard failed, trying fallback:', err);
      }
      // Fallback: hidden textarea
      if (!copied) {
        copied = await copyTextToClipboard(clipboardText);
      }

      showToast(`Copied ${response.cookieCount} cookies from ${response.domain}`, 'success');
      await updateStats();
      // Auto-close after short delay (if setting enabled)
      if (settings.autoClose) {
        setTimeout(() => window.close(), 1200);
      }
    } catch (err) {
      console.error('[SessionShare] Copy failed:', err);
      showToast(err.message, 'error');
    } finally {
      setBusy(false, $('btn-copy'));
    }
  }

  async function onPasteClick() {
    if (isBusy) return;
    setBusy(true, $('btn-paste'), 'Reading...');

    try {
      let clipboardText = null;

      // Method 1: navigator.clipboard API (preferred)
      try {
        clipboardText = await navigator.clipboard.readText();
      } catch (err) {
        console.warn('[SessionShare] navigator.clipboard.readText failed:', err);
      }

      // Method 2: fallback to stored lastCopiedSession (same browser only)
      if (!clipboardText || !clipboardText.includes(OMNIBOX_KEYWORD)) {
        const stored = await chrome.storage.local.get(['lastCopiedSession']);
        if (stored.lastCopiedSession && stored.lastCopiedSession.includes(OMNIBOX_KEYWORD)) {
          clipboardText = stored.lastCopiedSession;
        }
      }

      // Method 3: if both fail, show manual paste modal (cross-browser fallback)
      if (!clipboardText || !clipboardText.includes(OMNIBOX_KEYWORD)) {
        showManualPasteModal();
        return;
      }

      // Preview before applying
      pendingPasteText = clipboardText;
      const previewResp = await sendMessage({ action: 'previewToken', text: clipboardText });
      if (previewResp?.success) {
        showPreview(previewResp.preview);
      } else {
        applyPasteWithText(clipboardText);
      }
    } catch (err) {
      console.error('[SessionShare] Paste failed:', err);
      showToast(err.message, 'error');
    } finally {
      setBusy(false, $('btn-paste'));
    }
  }

  // ---------- MANUAL PASTE MODAL (cross-browser fallback) ----------
  function showManualPasteModal() {
    $('manual-paste-input').value = '';
    $('manual-paste-modal').classList.add('active');
    setTimeout(() => $('manual-paste-input').focus(), 100);
  }

  async function onManualPasteApply() {
    const text = $('manual-paste-input').value.trim();
    if (!text) {
      showToast('Please paste a session token', 'error');
      return;
    }
    if (!text.includes(OMNIBOX_KEYWORD)) {
      showToast('Invalid token — must start with "session_paste"', 'error');
      return;
    }
    closeModalById('manual-paste-modal');
    pendingPasteText = text;
    setBusy(true, $('btn-paste'), 'Previewing...');
    try {
      const previewResp = await sendMessage({ action: 'previewToken', text });
      if (previewResp?.success) {
        showPreview(previewResp.preview);
      } else {
        applyPasteWithText(text);
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(false, $('btn-paste'));
    }
  }

  function showPreview(preview) {
    $('preview-domain').textContent = preview.domain || '—';
    $('preview-count').textContent = preview.cookieCount;
    $('preview-httponly').textContent = preview.httpOnlyCount;
    $('preview-secure').textContent = preview.secureCount;
    $('preview-session').textContent = preview.sessionCookieCount;

    if (preview.expiry && preview.expiry > 0) {
      const expiryDate = new Date(preview.expiry);
      const isExpired = preview.isExpired;
      $('preview-expiry').textContent = isExpired
        ? `EXPIRED (${expiryDate.toLocaleString()})`
        : expiryDate.toLocaleString();
      $('preview-expiry').style.color = isExpired ? '#EF4444' : '#111827';
    } else {
      $('preview-expiry').textContent = 'Never';
      $('preview-expiry').style.color = '#111827';
    }

    if (preview.cookieNames && preview.cookieNames.length > 0) {
      const names = preview.cookieNames.join(', ');
      const extra = preview.cookieCount > 10 ? ` (+${preview.cookieCount - 10} more)` : '';
      $('preview-cookie-names').textContent = `Cookies: ${names}${extra}`;
    } else {
      $('preview-cookie-names').textContent = '';
    }

    $('preview-modal').classList.add('active');
  }

  async function applyPasteWithText(text) {
    setBusy(true, $('btn-paste'), 'Pasting...');
    try {
      const response = await sendMessage({
        action: 'pasteSessionWithText',
        text: text
      });
      if (!response?.success) {
        throw new Error(response?.error || 'Paste failed');
      }
      showToast(`Applied ${response.cookiesSet} cookies for ${response.domain}`, 'success');
      if (settings.autoClose) {
        setTimeout(() => window.close(), 1000);
      }
    } catch (err) {
      console.error('[SessionShare] Apply paste failed:', err);
      showToast(err.message, 'error');
    } finally {
      setBusy(false, $('btn-paste'));
    }
  }

  // ---------- Account management ----------

  async function refreshAccountList() {
    try {
      const response = await sendMessage({ action: 'listSavedSessions' });
      if (!response?.success) {
        throw new Error(response?.error || 'Failed to load sessions');
      }

      // Cache for search filtering
      allSessions = response.sessions || [];

      // If search bar is visible and has a query, defer to filterAccounts
      const searchBar = $('search-bar');
      const searchInput = $('search-input');
      if (searchBar?.classList.contains('visible') && searchInput?.value.trim()) {
        filterAccounts(searchInput.value.toLowerCase().trim());
        return;
      }

      // Render CURRENT SESSION (account 1) in its own container — always at top
      currentSessionList.innerHTML = '';
      renderEmptySlotInto(currentSessionList, 1);

      // Render saved sessions in accounts-list container
      accountsList.innerHTML = '';

      const sessions = response.sessions || [];

      const emptyHint = $('empty-hint');
      if (sessions.length === 0) {
        if (emptyHint) emptyHint.style.display = 'block';
        const sortBar = $('sort-bar');
        if (sortBar) sortBar.style.display = 'none';
      } else {
        if (emptyHint) emptyHint.style.display = 'none';

        // Show sort bar only when more than 1 saved session
        const sortBar = $('sort-bar');
        if (sortBar) sortBar.style.display = sessions.length > 1 ? 'flex' : 'none';

        // Sort sessions
        const sortedSessions = sortSessions(sessions);

        // Render all saved sessions (sorted)
        for (const s of sortedSessions) {
          renderSessionCard(s);
        }
      }
    } catch (err) {
      console.error('[SessionShare] Refresh failed:', err);
      // Fallback: show CURRENT SESSION empty slot
      currentSessionList.innerHTML = '';
      renderEmptySlotInto(currentSessionList, 1);
      accountsList.innerHTML = '';
      const sortBar = $('sort-bar');
      if (sortBar) sortBar.style.display = 'none';
    }
  }

  // ---------- Sort logic ----------
  function sortSessions(sessions) {
    const arr = [...sessions];
    switch (sortMode) {
      case 'oldest':
        arr.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        break;
      case 'domain-az':
        arr.sort((a, b) => (a.domain || '').localeCompare(b.domain || ''));
        break;
      case 'domain-za':
        arr.sort((a, b) => (b.domain || '').localeCompare(a.domain || ''));
        break;
      case 'most-used':
        arr.sort((a, b) => (b.useCount || 0) - (a.useCount || 0));
        break;
      case 'recent':
      default:
        arr.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        break;
    }
    return arr;
  }

  function renderEmptySlot(num) {
    renderEmptySlotInto(accountsList, num);
  }

  function renderEmptySlotInto(container, num) {
    const card = document.createElement('div');
    card.className = 'account-card empty';
    card.dataset.account = num;

    const dot = document.createElement('div');
    dot.className = 'account-dot';

    const info = document.createElement('div');
    info.className = 'account-info';

    const title = document.createElement('div');
    title.className = 'account-title';
    title.textContent = num === 1 ? 'CURRENT SESSION' : 'Account ' + num;

    const meta = document.createElement('div');
    meta.className = 'account-meta';
    meta.textContent = num === 1 ? 'Click Save Session to capture current page' : 'No session saved';

    info.appendChild(title);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'account-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'card-btn btn-save';
    saveBtn.title = 'Save current page session here';
    saveBtn.textContent = 'Save Session';
    saveBtn.addEventListener('click', () => onSaveToAccount(num));
    actions.appendChild(saveBtn);

    card.appendChild(dot);
    card.appendChild(info);
    card.appendChild(actions);
    container.appendChild(card);
  }

  function renderSessionCard(s) {
    const card = document.createElement('div');
    card.className = 'account-card has-session';
    card.dataset.account = s.accountNumber;

    const dateStr = s.timestamp ? new Date(s.timestamp).toLocaleDateString() : '';
    const meta = [s.domain, dateStr].filter(Boolean).join(' · ') || 'Session saved';

    // Display name: customName > tabTitle (if short) > domain
    const rawTitle = s.tabTitle || '';
    const shortTitle = rawTitle.length > 0 && rawTitle.length <= 25 ? rawTitle : null;
    const displayName = s.customName || shortTitle || s.domain || s.url || ('Account ' + s.accountNumber);

    // ---------- Favicon (safe DOM API) ----------
    if (s.favicon) {
      const faviconImg = document.createElement('img');
      faviconImg.className = 'account-favicon';
      faviconImg.src = s.favicon;
      faviconImg.alt = '';

      const fallbackDiv = document.createElement('div');
      fallbackDiv.className = 'account-favicon fallback';
      fallbackDiv.style.display = 'none';
      fallbackDiv.textContent = displayName.charAt(0);

      faviconImg.addEventListener('error', () => {
        faviconImg.style.display = 'none';
        fallbackDiv.style.display = 'flex';
      });

      card.appendChild(faviconImg);
      card.appendChild(fallbackDiv);
    } else {
      const fallbackDiv = document.createElement('div');
      fallbackDiv.className = 'account-favicon fallback';
      fallbackDiv.textContent = displayName.charAt(0);
      card.appendChild(fallbackDiv);
    }

    // ---------- Info section ----------
    const info = document.createElement('div');
    info.className = 'account-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'account-title-row';

    const title = document.createElement('span');
    title.className = 'account-title';
    title.title = 'Click to rename';
    title.textContent = displayName;
    title.style.cursor = 'pointer';

    const editBtn = document.createElement('button');
    editBtn.className = 'edit-name-btn';
    editBtn.title = 'Rename';
    editBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';

    titleRow.appendChild(title);
    titleRow.appendChild(editBtn);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'account-meta';
    metaDiv.textContent = meta;

    info.appendChild(titleRow);
    info.appendChild(metaDiv);

    // Usage badge
    const useCount = s.useCount || 0;
    if (useCount > 0) {
      const lastUsedStr = s.lastUsed ? formatTimeAgo(s.lastUsed) : '';
      const usageBadge = document.createElement('div');
      usageBadge.className = 'usage-badge';
      usageBadge.textContent = 'Used ' + useCount + '×' + (lastUsedStr ? ' · ' + lastUsedStr : '');
      info.appendChild(usageBadge);
    }

    card.appendChild(info);

    // ---------- Actions ----------
    const actions = document.createElement('div');
    actions.className = 'account-actions';

    const loginBtn = document.createElement('button');
    loginBtn.className = 'card-btn btn-login';
    loginBtn.title = 'Open site and apply session';
    loginBtn.textContent = 'Log in';

    const shareBtn = document.createElement('button');
    shareBtn.className = 'btn-share';
    shareBtn.title = 'Copy shareable token to clipboard';
    shareBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92c0-1.61-1.31-2.92-2.92-2.92z"/></svg>';

    actions.appendChild(loginBtn);
    actions.appendChild(shareBtn);
    card.appendChild(actions);

    // ---------- Delete badge ----------
    const deleteBadge = document.createElement('button');
    deleteBadge.className = 'delete-badge';
    deleteBadge.title = 'Remove saved session';
    deleteBadge.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    card.appendChild(deleteBadge);

    // ---------- Wire up buttons ----------
    loginBtn.addEventListener('click', () => onLoadAccount(s.accountNumber));
    shareBtn.addEventListener('click', () => onShareAccount(s.accountNumber));
    deleteBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      onDeleteAccount(s.accountNumber);
    });

    // Rename on title click or edit button click
    const renameHandler = () => onRenameSession(s.accountNumber, s.customName || s.domain || s.tabTitle);
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      renameHandler();
    });
    title.addEventListener('click', () => {
      renameHandler();
    });

    accountsList.appendChild(card);
  }

  // ---------- RENAME SESSION ----------
  async function onRenameSession(accountNumber, currentName) {
    const newName = prompt('Enter a custom name for this session:', currentName || '');
    if (newName === null) return; // user cancelled
    try {
      const response = await sendMessage({
        action: 'renameSession',
        accountNumber,
        customName: newName
      });
      if (!response?.success) {
        throw new Error(response?.error || 'Rename failed');
      }
      showToast(newName.trim() ? 'Renamed' : 'Name reset to default', 'success');
      await refreshAccountList();
    } catch (err) {
      console.error('[SessionShare] Rename failed:', err);
      showToast(err.message, 'error');
    }
  }

  async function onSaveToAccount(accountNumber) {
    if (isBusy) return;
    // Search BOTH containers — CURRENT SESSION is in currentSessionList,
    // saved sessions are in accountsList
    const card = currentSessionList.querySelector(`[data-account="${accountNumber}"]`) ||
                 accountsList.querySelector(`[data-account="${accountNumber}"]`);
    const btn = card?.querySelector('.btn-save');
    if (btn) {
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = '';
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      btn.appendChild(spinner);
      btn.appendChild(document.createTextNode('Saving'));
      try {
        // DIRECT SAVE — no clipboard needed.
        // Get the active tab's URL + title and send to background to read cookies + save.
        const tab = await getActiveTab();
        if (!tab || !tab.url) {
          throw new Error('No active tab found. Open a website first.');
        }

        // Validate URL is a regular web page
        if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
          throw new Error('Cannot save session from this page. Open a regular website (http/https).');
        }

        // Send to background: read cookies from this URL + save to a NEW account number
        // (CURRENT SESSION stays empty, saved session appears as new card below)
        const response = await sendMessage({
          action: 'saveCurrentTabSession',
          url: tab.url,
          tabTitle: tab.title || ''
        });

        if (!response?.success) {
          throw new Error(response?.error || 'Save failed');
        }

        showToast(`Saved ${response.cookieCount} cookies from ${response.domain}`, 'success');
        await refreshAccountList();
        await updateStats();
      } catch (err) {
        console.error('[SessionShare] Save failed:', err);
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  }

  async function onLoadAccount(accountNumber) {
    if (isBusy) return;
    const card = accountsList.querySelector(`[data-account="${accountNumber}"]`);
    const btn = card?.querySelector('.btn-login');
    if (btn) {
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = '';
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      btn.appendChild(spinner);
      btn.appendChild(document.createTextNode('Loading'));
      try {
        const response = await sendMessage({ action: 'loadSavedSession', accountNumber });
        if (!response?.success) {
          throw new Error(response?.error || 'Load failed');
        }
        showToast(`Loaded ${response.domain}`, 'success');
        if (settings.autoClose) {
          setTimeout(() => window.close(), 800);
        }
      } catch (err) {
        console.error('[SessionShare] Load failed:', err);
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  }

  // (Old onShareAccount removed — replaced by share modal version above)

  async function onDeleteAccount(accountNumber) {
    showConfirm(
      'Delete Session',
      `Remove saved session from account ${accountNumber}? This cannot be undone.`,
      async () => {
        try {
          const response = await sendMessage({ action: 'deleteSavedSession', accountNumber });
          if (!response?.success) {
            throw new Error(response?.error || 'Delete failed');
          }
          showToast('Session deleted', 'success');
          await refreshAccountList();
          await updateStats();
        } catch (err) {
          console.error('[SessionShare] Delete failed:', err);
          showToast(err.message, 'error');
        }
      }
    );
  }

  async function onClearAll() {
    showConfirm(
      'Clear All Data',
      'This will permanently delete ALL saved sessions and rotate your encryption key. Continue?',
      async () => {
        try {
          const response = await sendMessage({ action: 'deleteAllData' });
          if (!response?.success) {
            throw new Error(response?.error || 'Clear failed');
          }
          showToast('All data cleared', 'success');
          await refreshAccountList();
          await updateStats();
        } catch (err) {
          console.error('[SessionShare] Clear all failed:', err);
          showToast(err.message, 'error');
        }
      }
    );
  }

  // ---------- Stats ----------

  async function updateStats() {
    try {
      const response = await sendMessage({ action: 'getStats' });
      if (response?.success) {
        const stats = response.stats;
        let text = `${stats.sessionCount} saved session${stats.sessionCount === 1 ? '' : 's'}`;
        if (stats.lastCopiedDomain) {
          text += ` · last copy: ${stats.lastCopiedDomain}`;
        }
        statsText.textContent = text;
      } else {
        statsText.textContent = 'Ready';
      }
    } catch {
      statsText.textContent = 'Ready';
    }
  }

  // ---------- Helpers ----------

  function sendMessage(message) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: 'Background did not respond (timeout)' });
      }, 10000);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { success: false, error: 'Empty response' });
        });
      } catch (err) {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
      }
    });
  }

  // Get active tab — works on desktop (currentWindow) and Android (lastFocusedWindow fallback)
  async function getActiveTab() {
    // Try desktop first (currentWindow)
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs.length > 0 && tabs[0].url) {
        return tabs[0];
      }
    } catch (err) {
      console.warn('[SessionShare] tabs.query(currentWindow) failed:', err);
    }
    // Fallback: lastFocusedWindow (works on Android where currentWindow may be undefined)
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tabs && tabs.length > 0 && tabs[0].url) {
        return tabs[0];
      }
    } catch (err) {
      console.warn('[SessionShare] tabs.query(lastFocusedWindow) failed:', err);
    }
    // Final fallback: any active tab
    try {
      const tabs = await chrome.tabs.query({ active: true });
      if (tabs && tabs.length > 0) {
        return tabs[0];
      }
    } catch (err) {
      console.warn('[SessionShare] tabs.query(active) failed:', err);
    }
    return null;
  }

  function setBusy(busy, button, loadingText) {
    if (!button) {
      isBusy = busy;
      return;
    }
    if (busy) {
      // Save original text content (safe — no innerHTML)
      if (!button.dataset.originalText) {
        button.dataset.originalText = button.textContent;
      }
      isBusy = true;
      button.disabled = true;
      if (loadingText) {
        button.textContent = '';
        const spinner = document.createElement('span');
        spinner.className = 'spinner';
        button.appendChild(spinner);
        button.appendChild(document.createTextNode(loadingText));
      }
    } else {
      isBusy = false;
      button.disabled = false;
      if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
      }
    }
  }

  let toastTimer = null;
  function showToast(message, type) {
    toastEl.textContent = message;
    toastEl.className = 'toast visible' + (type ? ' ' + type : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.className = 'toast' + (type ? ' ' + type : '');
    }, 3500);
  }

  let currentConfirm = null;
  function showConfirm(title, message, onConfirm) {
    $('modal-title').textContent = title;
    $('modal-message').textContent = message;
    currentConfirm = { onConfirm };
    $('confirm-modal').classList.add('active');
  }

  function closeModal() {
    $('confirm-modal').classList.remove('active');
    currentConfirm = null;
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Format time ago (e.g., "2h ago", "3d ago")
  function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 30) return new Date(timestamp).toLocaleDateString();
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
  }
})();
