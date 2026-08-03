// Session Share - Content script
// ============================================
// Clipboard relay: handles copy/read requests from background script.
// Uses navigator.clipboard API (modern) with execCommand fallback (legacy).
// Minimal surface area — only responds to known actions from our extension.

(function () {
  'use strict';

  const ALLOWED_ACTIONS = new Set(['copyToClipboard', 'readClipboard']);

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Only accept messages from our own extension
    if (!sender || sender.id !== chrome.runtime.id) {
      sendResponse({ success: false, error: 'Unauthorized sender' });
      return false;
    }

    if (!request || !ALLOWED_ACTIONS.has(request.action)) {
      sendResponse({ success: false, error: 'Unknown or missing action' });
      return false;
    }

    if (request.action === 'copyToClipboard') {
      copyTextToClipboard(request.text)
        .then(() => sendResponse({ success: true }))
        .catch(err => {
          console.warn('[SessionShare] copy failed:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true; // keep channel open for async response
    }

    if (request.action === 'readClipboard') {
      readTextFromClipboard()
        .then(text => sendResponse({ success: true, text }))
        .catch(err => {
          console.warn('[SessionShare] read failed:', err);
          sendResponse({ success: false, error: err.message });
        });
      return true;
    }

    // Unreachable, but defensive
    sendResponse({ success: false, error: 'Unhandled action' });
    return false;
  });

  async function copyTextToClipboard(text) {
    if (typeof text !== 'string') {
      throw new Error('Text must be a string');
    }

    // Modern API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (err) {
        console.warn('[SessionShare] navigator.clipboard.writeText failed, falling back:', err);
      }
    }

    // Fallback: hidden textarea + execCommand
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);

    try {
      const selection = document.getSelection();
      const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

      textarea.select();
      const ok = document.execCommand('copy');
      if (!ok) {
        throw new Error('execCommand copy returned false');
      }

      // Restore previous selection
      if (savedRange && selection) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      }
    } finally {
      document.body.removeChild(textarea);
    }
  }

  async function readTextFromClipboard() {
    // Modern API first
    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) return text;
      } catch (err) {
        console.warn('[SessionShare] navigator.clipboard.readText failed, falling back:', err);
      }
    }

    // Fallback: hidden textarea + execCommand paste
    const textarea = document.createElement('textarea');
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);

    try {
      textarea.focus();
      const ok = document.execCommand('paste');
      if (!ok) {
        throw new Error('execCommand paste returned false (browser may block it)');
      }
      return textarea.value || '';
    } finally {
      document.body.removeChild(textarea);
    }
  }
})();
