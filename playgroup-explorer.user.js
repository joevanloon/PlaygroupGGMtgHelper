// ==UserScript==
// @name         Playgroup.gg Auto-Organizer
// @namespace    https://playgroup.gg/
// @version      2.0.0
// @description  Auto-organizes your board on pass turn. Press Alt+Shift+E to open the explorer panel.
// @author       You
// @match        https://playgroup.gg/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// HOW TO USE:
//   Production mode: once selectors are configured, the script silently hooks
//   pass-turn and auto-organizes your board.
//
//   Explorer mode: press Alt+Shift+E to open the diagnostic panel. It will
//   guide you through capturing selectors and export a full event log so you
//   can see exactly what the game is doing under the hood.

console.log('[PG] Playgroup.gg Auto-Organizer v2.0 loading...');

(function () {
  'use strict';

  console.log('[PG] Script IIFE started');

  // ── Try/catch the whole thing so any error surfaces clearly ──────────────────
  try {
    main();
  } catch (err) {
    console.error('[PG] Fatal error during init:', err);
  }

  function main() {
    console.log('[PG] main() called, URL:', location.href);

    // ─────────────────────────────────────────────────────────────────────────
    // STORAGE — persists discovered selectors across reloads
    // ─────────────────────────────────────────────────────────────────────────
    const STORAGE_KEY = 'pg_ao_config_v2';

    const DEFAULTS = {
      passTurnSelector: null,
      passTurnKey: null,
      organizeBtnSelector: null,
      boardSelector: null,
      cardSelector: null,
      autoOrganizeOnPassTurn: true,
      organizeDelay: 300,
    };

    let CFG = Object.assign({}, DEFAULTS);
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      Object.assign(CFG, saved);
      console.log('[PG] Loaded saved config:', CFG);
    } catch (e) {
      console.warn('[PG] Could not load saved config:', e);
    }

    function saveConfig() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(CFG));
      console.log('[PG] Config saved:', CFG);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXPLORER MODE FLAG
    // ─────────────────────────────────────────────────────────────────────────
    let explorerOpen = false;

    // ─────────────────────────────────────────────────────────────────────────
    // EVENT LOG
    // ─────────────────────────────────────────────────────────────────────────
    const MAX_EVENTS = 500;
    const eventLog = [];

    function logEv(type, source, data) {
      const entry = {
        t: new Date().toISOString(),
        type,
        source: String(source).slice(0, 120),
        data,
      };
      eventLog.unshift(entry);
      if (eventLog.length > MAX_EVENTS) eventLog.pop();
      if (explorerOpen) refreshLogPanel();
      // Always log to console in explorer mode
      if (explorerOpen) {
        console.log(`[PG:${type}]`, source, data);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GLOBAL WATCHERS — only active when explorer is open
    // ─────────────────────────────────────────────────────────────────────────
    let watchersActive = false;
    let mutationObserver = null;
    const patchedSymbol = Symbol('pg_patched');

    function startWatchers() {
      if (watchersActive) return;
      watchersActive = true;
      console.log('[PG] Starting global watchers');

      // ── Intercept fetch ───────────────────────────────────────────────────
      if (!window.fetch[patchedSymbol]) {
        const origFetch = window.fetch.bind(window);
        window.fetch = function (...args) {
          const url = String(args[0]?.url || args[0] || '');
          const method = String(args[1]?.method || 'GET');
          const body = args[1]?.body;
          logEv('FETCH', `${method} ${url}`, { body: body ? String(body).slice(0, 200) : null });
          return origFetch(...args);
        };
        window.fetch[patchedSymbol] = true;
      }

      // ── Intercept XHR ────────────────────────────────────────────────────
      if (!XMLHttpRequest.prototype[patchedSymbol]) {
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
          this._pg_url = url;
          this._pg_method = method;
          return origOpen.call(this, method, url, ...rest);
        };
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (body) {
          logEv('XHR', `${this._pg_method} ${this._pg_url}`, { body: body ? String(body).slice(0, 200) : null });
          return origSend.call(this, body);
        };
        XMLHttpRequest.prototype[patchedSymbol] = true;
      }

      // ── Intercept WebSocket ───────────────────────────────────────────────
      if (!window.WebSocket[patchedSymbol]) {
        const OrigWS = window.WebSocket;
        function PatchedWS(url, protocols) {
          const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
          logEv('WS-OPEN', url, {});
          ws.addEventListener('message', (ev) => {
            try {
              const parsed = JSON.parse(ev.data);
              logEv('WS-MSG', url, parsed);
            } catch (_) {
              logEv('WS-MSG-RAW', url, { raw: String(ev.data).slice(0, 300) });
            }
          });
          ws.addEventListener('close', () => logEv('WS-CLOSE', url, {}));
          return ws;
        }
        PatchedWS.prototype = OrigWS.prototype;
        Object.defineProperty(PatchedWS, 'CONNECTING', { get: () => OrigWS.CONNECTING });
        Object.defineProperty(PatchedWS, 'OPEN', { get: () => OrigWS.OPEN });
        Object.defineProperty(PatchedWS, 'CLOSING', { get: () => OrigWS.CLOSING });
        Object.defineProperty(PatchedWS, 'CLOSED', { get: () => OrigWS.CLOSED });
        PatchedWS[patchedSymbol] = true;
        window.WebSocket = PatchedWS;
      }

      // ── Intercept dispatchEvent ───────────────────────────────────────────
      if (!EventTarget.prototype.dispatchEvent[patchedSymbol]) {
        const origDispatch = EventTarget.prototype.dispatchEvent;
        EventTarget.prototype.dispatchEvent = function (event) {
          const skip = /^(mouse|pointer|touch|scroll|resize|focus|blur|input|change|transition|animation|drag|wheel|select)/i;
          if (!skip.test(event.type)) {
            logEv('DISPATCH', event.type, {
              target: selectorFor(this),
              detail: event.detail ?? null,
            });
          }
          return origDispatch.call(this, event);
        };
        EventTarget.prototype.dispatchEvent[patchedSymbol] = true;
      }

      // ── Click listener — log all clicks with selector ─────────────────────
      document._pg_clickListener = (e) => {
        if (captureClickActive) return; // handled by capture mode
        logEv('CLICK', selectorFor(e.target), {
          text: e.target.textContent?.trim().slice(0, 60),
          tag: e.target.tagName,
          class: e.target.className,
        });
      };
      document.addEventListener('click', document._pg_clickListener, true);

      // ── Key listener ──────────────────────────────────────────────────────
      document._pg_keyListener = (e) => {
        if (captureKeyActive) return;
        if (e.target.matches('input, textarea, [contenteditable]')) return;
        logEv('KEYDOWN', e.code, { key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
      };
      document.addEventListener('keydown', document._pg_keyListener, true);

      // ── DOM mutation observer ─────────────────────────────────────────────
      mutationObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue;
            const text = (node.textContent || '').trim().slice(0, 60);
            const cls = String(node.className || '');
            const dataAction = node.getAttribute?.('data-action') || '';
            const dataCtrl = node.getAttribute?.('data-controller') || '';
            if (/pass|turn|organiz|arrange|end.*turn|phase|step/i.test(text + cls + dataAction + dataCtrl)) {
              logEv('DOM-ADD', selectorFor(node), { text, class: cls, dataAction, dataCtrl });
            }
          }
        }
      });
      mutationObserver.observe(document.body, { childList: true, subtree: true });

      console.log('[PG] All watchers active');
    }

    function stopWatchers() {
      if (!watchersActive) return;
      watchersActive = false;
      if (document._pg_clickListener) {
        document.removeEventListener('click', document._pg_clickListener, true);
      }
      if (document._pg_keyListener) {
        document.removeEventListener('keydown', document._pg_keyListener, true);
      }
      if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
      }
      console.log('[PG] Watchers stopped (fetch/XHR/WS/dispatchEvent patches remain until page reload)');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SELECTOR BUILDER
    // ─────────────────────────────────────────────────────────────────────────
    function selectorFor(el) {
      if (!el || el === document || el === window || el === document.body) return '(body)';
      if (el.nodeType !== 1) return '(non-element)';

      // Prefer ID
      if (el.id) return `#${el.id}`;

      // Walk up to build a path
      const parts = [];
      let cur = el;
      let depth = 0;
      while (cur && cur !== document.body && depth < 6) {
        if (cur.id) { parts.unshift(`#${cur.id}`); break; }

        let part = cur.tagName.toLowerCase();
        const dataAction = cur.getAttribute?.('data-action');
        const dataCtrl = cur.getAttribute?.('data-controller');
        const dataZone = cur.getAttribute?.('data-zone');
        const dataCard = cur.getAttribute?.('data-card-id') || cur.getAttribute?.('data-card') || cur.getAttribute?.('data-permanent-id');

        if (dataCard) { parts.unshift(`[data-card-id="${dataCard}"]`); break; }
        if (dataZone) part += `[data-zone="${dataZone}"]`;
        else if (dataAction) part += `[data-action="${dataAction}"]`;
        else if (dataCtrl) part += `[data-controller="${dataCtrl}"]`;
        else {
          const cls = [...(cur.classList || [])]
            .filter(c => !/^(text-|bg-|p[xytrbl]?-|m[xytrbl]?-|w-|h-|flex|grid|block|inline|hidden|rounded|border|shadow|cursor|hover:|focus:|active:|transition|duration|ease|opacity|z-|overflow|whitespace|truncate|sr-)/.test(c))
            .slice(0, 3);
          if (cls.length) part += '.' + cls.join('.');
        }
        parts.unshift(part);
        cur = cur.parentElement;
        depth++;
      }
      return parts.join(' > ') || el.tagName.toLowerCase();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ELEMENT CAPTURE — click or key capture modes
    // ─────────────────────────────────────────────────────────────────────────
    let captureClickActive = false;
    let captureKeyActive = false;
    let highlightedEl = null;

    function startClickCapture(onCapture) {
      captureClickActive = true;
      document.body.style.cursor = 'crosshair';

      const onHover = (e) => {
        if (highlightedEl) highlightedEl.classList.remove('pg-capture-highlight');
        highlightedEl = e.target;
        highlightedEl.classList.add('pg-capture-highlight');
      };
      const onClick = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (highlightedEl) highlightedEl.classList.remove('pg-capture-highlight');
        document.body.style.cursor = '';
        document.removeEventListener('mouseover', onHover, true);
        document.removeEventListener('click', onClick, true);
        captureClickActive = false;
        onCapture(e.target, selectorFor(e.target));
      };
      document.addEventListener('mouseover', onHover, true);
      document.addEventListener('click', onClick, true);
    }

    function startKeyCapture(onCapture) {
      captureKeyActive = true;
      const onKey = (e) => {
        document.removeEventListener('keydown', onKey, true);
        captureKeyActive = false;
        onCapture(e);
      };
      document.addEventListener('keydown', onKey, true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BOARD ORGANIZER
    // ─────────────────────────────────────────────────────────────────────────
    function organizeBoard() {
      const boardSel = CFG.boardSelector;
      const cardSel = CFG.cardSelector;

      if (!boardSel || !cardSel) {
        console.log('[PG] organizeBoard: selectors not configured yet');
        return false;
      }

      const board = document.querySelector(boardSel);
      if (!board) {
        console.log('[PG] organizeBoard: board element not found for selector:', boardSel);
        return false;
      }

      const cards = [...board.querySelectorAll(cardSel)];
      if (!cards.length) {
        console.log('[PG] organizeBoard: no cards found for selector:', cardSel);
        return false;
      }

      console.log(`[PG] organizeBoard: arranging ${cards.length} cards`);

      const boardRect = board.getBoundingClientRect();
      const cols = Math.ceil(Math.sqrt(cards.length));
      const cardW = Math.floor((boardRect.width - (cols + 1) * 8) / cols);
      const cardH = Math.floor(cardW * 1.4);

      cards.forEach((card, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = col * (cardW + 8) + 8;
        const y = row * (cardH + 8) + 8;
        card.style.position = 'absolute';
        card.style.left = `${x}px`;
        card.style.top = `${y}px`;
        card.style.transition = 'left 0.25s ease, top 0.25s ease';
      });

      logEv('ORGANIZE', boardSel, { cardCount: cards.length, cols });
      return true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PASS TURN HOOK — always active once selectors are known
    // ─────────────────────────────────────────────────────────────────────────
    let passTurnHooked = false;

    function hookPassTurn() {
      if (!CFG.passTurnSelector) return;

      const tryHook = () => {
        if (passTurnHooked) return;
        const btn = document.querySelector(CFG.passTurnSelector);
        if (!btn) return;

        btn.addEventListener('click', () => {
          console.log('[PG] Pass turn clicked');
          logEv('PASS-TURN', CFG.passTurnSelector, { trigger: 'click' });
          if (CFG.autoOrganizeOnPassTurn) {
            setTimeout(() => organizeBoard(), CFG.organizeDelay);
          }
        }, true);

        passTurnHooked = true;
        console.log('[PG] Pass-turn click hook active on:', CFG.passTurnSelector);
      };

      tryHook();
      // Re-try on DOM changes (Turbo navigation can replace buttons)
      const obs = new MutationObserver(tryHook);
      obs.observe(document.body, { childList: true, subtree: true });
    }

    function hookPassTurnKey() {
      if (!CFG.passTurnKey) return;
      document.addEventListener('keydown', (e) => {
        if (e.code !== CFG.passTurnKey) return;
        if (e.target.matches('input, textarea, [contenteditable]')) return;
        console.log('[PG] Pass turn key pressed:', CFG.passTurnKey);
        logEv('PASS-TURN', 'keyboard', { key: e.code });
        if (CFG.autoOrganizeOnPassTurn) {
          setTimeout(() => organizeBoard(), CFG.organizeDelay);
        }
      }, true);
      console.log('[PG] Pass-turn key hook active:', CFG.passTurnKey);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXPLORER UI
    // ─────────────────────────────────────────────────────────────────────────
    let panelEl = null;

    function buildStyles() {
      if (document.getElementById('pg-styles')) return;
      const s = document.createElement('style');
      s.id = 'pg-styles';
      s.textContent = `
        .pg-capture-highlight {
          outline: 3px solid #ff4500 !important;
          outline-offset: 2px !important;
          cursor: crosshair !important;
        }
        #pg-panel {
          position: fixed;
          top: 16px;
          right: 16px;
          width: 360px;
          max-height: 88vh;
          background: #111827;
          color: #d1d5db;
          border: 1px solid #374151;
          border-radius: 10px;
          font: 12px/1.4 monospace;
          z-index: 2147483647;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0,0,0,0.7);
          overflow: hidden;
        }
        #pg-panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          background: #1f2937;
          border-bottom: 1px solid #374151;
          cursor: move;
          user-select: none;
          flex-shrink: 0;
        }
        #pg-panel-header .title { font-weight: bold; color: #60a5fa; font-size: 13px; }
        #pg-panel-header .hint { color: #6b7280; font-size: 10px; margin-top: 1px; }
        #pg-panel-header-btns { display: flex; gap: 4px; }
        #pg-panel-header-btns button {
          background: none; border: 1px solid #4b5563; border-radius: 4px;
          color: #9ca3af; cursor: pointer; padding: 2px 7px; font-size: 11px; font-family: monospace;
        }
        #pg-panel-header-btns button:hover { background: #374151; color: #f3f4f6; }
        #pg-panel-body { overflow-y: auto; flex: 1; }

        .pg-section { border-bottom: 1px solid #1f2937; }
        .pg-section-head {
          display: flex; align-items: center; justify-content: space-between;
          padding: 7px 12px; background: #1e3a5f; cursor: pointer;
          font-weight: bold; color: #93c5fd; font-size: 11px; user-select: none;
        }
        .pg-section-head:hover { background: #1d4ed8; color: #fff; }
        .pg-section-content { padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; }
        .pg-section-content.collapsed { display: none; }

        .pg-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
        .pg-label { color: #6b7280; font-size: 10px; min-width: 72px; }
        .pg-val { color: #34d399; font-size: 10px; word-break: break-all; }
        .pg-val.empty { color: #6b7280; font-style: italic; }

        .pg-btn {
          padding: 4px 10px; border-radius: 5px; border: none; cursor: pointer;
          font: bold 11px monospace; transition: filter 0.15s; white-space: nowrap;
        }
        .pg-btn:hover { filter: brightness(1.2); }
        .pg-btn-blue   { background: #1d4ed8; color: #bfdbfe; }
        .pg-btn-green  { background: #065f46; color: #6ee7b7; }
        .pg-btn-red    { background: #7f1d1d; color: #fca5a5; }
        .pg-btn-yellow { background: #78350f; color: #fde68a; }
        .pg-btn-gray   { background: #374151; color: #d1d5db; }

        .pg-input {
          flex: 1; background: #0f172a; border: 1px solid #374151; border-radius: 4px;
          color: #34d399; padding: 3px 6px; font: 10px monospace; min-width: 0;
        }

        .pg-step {
          background: #0f172a; border: 1px solid #374151; border-radius: 6px;
          padding: 8px; display: flex; flex-direction: column; gap: 5px;
        }
        .pg-step.done { border-color: #065f46; }
        .pg-step.active { border-color: #1d4ed8; }
        .pg-step-title { font-weight: bold; font-size: 11px; }
        .pg-step.done .pg-step-title { color: #34d399; }
        .pg-step.active .pg-step-title { color: #60a5fa; }
        .pg-step-desc { color: #9ca3af; font-size: 10px; line-height: 1.4; }
        .pg-step-result {
          background: #0a1f0a; border: 1px solid #065f46; border-radius: 4px;
          padding: 4px 6px; color: #34d399; font-size: 10px; word-break: break-all;
        }
        .pg-status-msg { color: #fbbf24; font-size: 10px; font-style: italic; }

        #pg-log {
          background: #030712; border: 1px solid #1f2937; border-radius: 4px;
          padding: 6px; max-height: 220px; overflow-y: auto; font-size: 10px;
        }
        .pg-log-entry { padding: 2px 0; border-bottom: 1px solid #111827; line-height: 1.3; }
        .pg-log-entry:last-child { border-bottom: none; }
        .pg-log-t    { color: #4b5563; }
        .pg-log-type { color: #60a5fa; font-weight: bold; margin: 0 4px; }
        .pg-log-src  { color: #fbbf24; }
        .pg-log-data { color: #9ca3af; word-break: break-all; }
      `;
      document.head.appendChild(s);
    }

    // ── Wizard step definitions ───────────────────────────────────────────────
    const stepStatus = {}; // stepId -> string message while waiting

    const STEPS = [
      {
        id: 'pass-btn',
        title: '1. Capture "Pass Turn" button',
        desc: 'Click Start, then click the Pass Turn button in the game.',
        done: () => !!CFG.passTurnSelector,
        result: () => CFG.passTurnSelector,
        run(setStatus) {
          setStatus('Hover to highlight, click to capture...');
          startClickCapture((el, sel) => {
            CFG.passTurnSelector = sel;
            saveConfig();
            hookPassTurn();
            logEv('WIZARD', 'pass-btn', { sel, html: el.outerHTML.slice(0, 200) });
            setStatus(null);
            rerenderWizard();
          });
        },
      },
      {
        id: 'pass-key',
        title: '2. Capture "Pass Turn" keyboard shortcut (optional)',
        desc: 'Click Start, then press the key shortcut. Press Escape to skip.',
        done: () => CFG.passTurnKey !== null,
        result: () => CFG.passTurnKey || '(skipped)',
        run(setStatus) {
          setStatus('Press the pass-turn key... (Escape to skip)');
          startKeyCapture((e) => {
            CFG.passTurnKey = e.key === 'Escape' ? false : e.code;
            saveConfig();
            if (CFG.passTurnKey) hookPassTurnKey();
            logEv('WIZARD', 'pass-key', { code: e.code });
            setStatus(null);
            rerenderWizard();
          });
        },
      },
      {
        id: 'org-btn',
        title: '3. Capture "Organize Board" button (optional)',
        desc: 'If the game has an existing organize button, capture it. Escape to skip.',
        done: () => CFG.organizeBtnSelector !== null,
        result: () => CFG.organizeBtnSelector || '(skipped)',
        run(setStatus) {
          setStatus('Click the organize button... (Escape to skip)');
          const onEsc = (e) => {
            if (e.key !== 'Escape') return;
            document.removeEventListener('keydown', onEsc, true);
            if (captureClickActive) {
              // cancel capture
              captureClickActive = false;
              if (highlightedEl) { highlightedEl.classList.remove('pg-capture-highlight'); highlightedEl = null; }
              document.body.style.cursor = '';
            }
            CFG.organizeBtnSelector = false;
            saveConfig();
            setStatus(null);
            rerenderWizard();
          };
          document.addEventListener('keydown', onEsc, true);
          startClickCapture((el, sel) => {
            document.removeEventListener('keydown', onEsc, true);
            CFG.organizeBtnSelector = sel;
            saveConfig();
            logEv('WIZARD', 'org-btn', { sel });
            setStatus(null);
            rerenderWizard();
          });
        },
      },
      {
        id: 'board',
        title: '4. Capture board container',
        desc: 'Click Start, then click anywhere on the battlefield/board area.',
        done: () => !!CFG.boardSelector,
        result: () => CFG.boardSelector,
        run(setStatus) {
          setStatus('Click anywhere on the battlefield...');
          startClickCapture((el, sel) => {
            CFG.boardSelector = sel;
            saveConfig();
            logEv('WIZARD', 'board', { sel });
            setStatus(null);
            rerenderWizard();
          });
        },
      },
      {
        id: 'card',
        title: '5. Capture a card element',
        desc: 'Click Start, then click any card on the battlefield.',
        done: () => !!CFG.cardSelector,
        result: () => CFG.cardSelector,
        run(setStatus) {
          setStatus('Click any card on the battlefield...');
          startClickCapture((el, sel) => {
            const gen = generalizeCard(el, sel);
            CFG.cardSelector = gen;
            saveConfig();
            logEv('WIZARD', 'card', { specific: sel, generalized: gen });
            setStatus(null);
            rerenderWizard();
          });
        },
      },
      {
        id: 'test',
        title: '6. Test auto-organize',
        desc: 'Click to run the organizer now and see if cards rearrange.',
        done: () => false,
        result: () => null,
        run(setStatus) {
          const ok = organizeBoard();
          setStatus(ok ? '✅ Done — check your board!' : '❌ Failed — check selectors in Config tab');
          setTimeout(() => { setStatus(null); rerenderWizard(); }, 5000);
        },
      },
    ];

    function generalizeCard(el, sel) {
      const dataKeys = ['data-card-id', 'data-card', 'data-permanent-id', 'data-permanent', 'data-object-id'];
      for (const k of dataKeys) {
        if (el.hasAttribute(k)) return `[${k}]`;
        const ancestor = el.closest(`[${k}]`);
        if (ancestor) return `[${k}]`;
      }
      // Strip positional/utility classes, keep structural ones
      const tag = el.tagName.toLowerCase();
      const cls = [...el.classList]
        .filter(c => !/^(top-|left-|right-|bottom-|translate|absolute|relative|w-|h-|rotate|scale)/.test(c))
        .slice(0, 2);
      return cls.length ? `${tag}.${cls.join('.')}` : sel;
    }

    // ── Render helpers ────────────────────────────────────────────────────────
    function rerenderWizard() {
      const container = document.getElementById('pg-wizard-steps');
      if (!container) return;
      container.innerHTML = '';
      STEPS.forEach(step => {
        const isDone = step.done();
        const statusMsg = stepStatus[step.id];
        const result = step.result?.();

        const div = document.createElement('div');
        div.className = `pg-step ${isDone ? 'done' : ''} ${statusMsg ? 'active' : ''}`;

        div.innerHTML = `
          <div class="pg-step-title">${isDone ? '✅' : '⭕'} ${step.title}</div>
          <div class="pg-step-desc">${step.desc}</div>
          ${result ? `<div class="pg-step-result">${esc(result)}</div>` : ''}
          ${statusMsg ? `<div class="pg-status-msg">${esc(statusMsg)}</div>` : ''}
        `;

        if (!statusMsg) {
          const btn = document.createElement('button');
          btn.className = `pg-btn ${isDone ? 'pg-btn-green' : 'pg-btn-blue'}`;
          btn.textContent = isDone ? '↺ Re-capture' : '▶ Start';
          btn.onclick = () => {
            step.run((msg) => {
              stepStatus[step.id] = msg;
              rerenderWizard();
            });
            stepStatus[step.id] = 'Starting...';
            rerenderWizard();
          };
          div.appendChild(btn);
        }

        container.appendChild(div);
      });
    }

    function refreshLogPanel() {
      const el = document.getElementById('pg-log');
      if (!el) return;
      el.innerHTML = eventLog.slice(0, 100).map(e => `
        <div class="pg-log-entry">
          <span class="pg-log-t">${e.t.slice(11, 23)}</span>
          <span class="pg-log-type">${esc(e.type)}</span>
          <span class="pg-log-src">${esc(e.source)}</span>
          <span class="pg-log-data"> ${esc(JSON.stringify(e.data).slice(0, 120))}</span>
        </div>
      `).join('') || '<div style="color:#4b5563;font-style:italic">No events yet — interact with the game.</div>';
    }

    function refreshConfigPanel() {
      const el = document.getElementById('pg-config-fields');
      if (!el) return;
      const fields = [
        { key: 'passTurnSelector', label: 'Pass btn' },
        { key: 'passTurnKey', label: 'Pass key' },
        { key: 'organizeBtnSelector', label: 'Org btn' },
        { key: 'boardSelector', label: 'Board' },
        { key: 'cardSelector', label: 'Card' },
      ];
      el.innerHTML = fields.map(f => `
        <div class="pg-row">
          <span class="pg-label">${f.label}</span>
          <input class="pg-input" data-key="${f.key}" value="${esc(String(CFG[f.key] ?? ''))}" placeholder="(not set)">
        </div>
      `).join('') + `
        <div class="pg-row">
          <span class="pg-label">Auto-org</span>
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer">
            <input type="checkbox" id="pg-auto-org-chk" ${CFG.autoOrganizeOnPassTurn ? 'checked' : ''}>
            <span style="color:#9ca3af;font-size:10px">on pass turn</span>
          </label>
        </div>
        <div class="pg-row">
          <span class="pg-label">Delay (ms)</span>
          <input class="pg-input" id="pg-delay-input" value="${CFG.organizeDelay}" style="width:60px;flex:none">
        </div>
        <div class="pg-row">
          <button class="pg-btn pg-btn-green" id="pg-save-cfg">💾 Save</button>
          <button class="pg-btn pg-btn-red" id="pg-reset-cfg">🗑 Reset All</button>
        </div>
      `;

      el.querySelector('#pg-save-cfg').onclick = () => {
        el.querySelectorAll('[data-key]').forEach(input => {
          const v = input.value.trim();
          CFG[input.dataset.key] = v === '' || v === 'null' ? null : v;
        });
        CFG.autoOrganizeOnPassTurn = el.querySelector('#pg-auto-org-chk').checked;
        CFG.organizeDelay = parseInt(el.querySelector('#pg-delay-input').value) || 300;
        saveConfig();
        passTurnHooked = false;
        hookPassTurn();
        hookPassTurnKey();
        rerenderWizard();
      };

      el.querySelector('#pg-reset-cfg').onclick = () => {
        if (confirm('Reset all discovered selectors and config?')) {
          localStorage.removeItem(STORAGE_KEY);
          location.reload();
        }
      };
    }

    function exportLog() {
      const blob = new Blob([JSON.stringify(eventLog, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `pg-explorer-log-${Date.now()}.json`;
      a.click();
    }

    function scanWindow() {
      const results = [];
      const scan = (obj, path, depth) => {
        if (depth > 3) return;
        try {
          Object.keys(obj || {}).forEach(k => {
            if (/^(on|webkit|moz|ms)/.test(k)) return;
            try {
              const v = obj[k];
              const p = `${path}.${k}`;
              if (/game|board|card|play|turn|organiz|arrange|zone|permanent|battle|hand|library/i.test(k)) {
                results.push({ path: p, type: typeof v, preview: String(v).slice(0, 80) });
                if (typeof v === 'object' && v !== null) scan(v, p, depth + 1);
              }
            } catch (_) {}
          });
        } catch (_) {}
      };
      scan(window, 'window', 0);
      logEv('WINDOW-SCAN', `Found ${results.length} game-related keys`, results);
      console.log('[PG] Window scan results:', results);
      refreshLogPanel();
    }

    // ── Build the panel ───────────────────────────────────────────────────────
    function openPanel() {
      if (panelEl) { panelEl.style.display = 'flex'; explorerOpen = true; startWatchers(); refreshLogPanel(); return; }

      buildStyles();
      panelEl = document.createElement('div');
      panelEl.id = 'pg-panel';

      panelEl.innerHTML = `
        <div id="pg-panel-header">
          <div>
            <div class="title">🔬 PG Explorer</div>
            <div class="hint">Alt+Shift+E to toggle</div>
          </div>
          <div id="pg-panel-header-btns">
            <button id="pg-min-btn">_</button>
            <button id="pg-close-btn">✕</button>
          </div>
        </div>
        <div id="pg-panel-body"></div>
      `;

      document.body.appendChild(panelEl);
      makeDraggable(panelEl, panelEl.querySelector('#pg-panel-header'));

      const body = panelEl.querySelector('#pg-panel-body');

      // Section helper
      function section(title, id, contentHtml, open = true) {
        const s = document.createElement('div');
        s.className = 'pg-section';
        s.innerHTML = `
          <div class="pg-section-head"><span>${title}</span><span>${open ? '▾' : '▸'}</span></div>
          <div class="pg-section-content ${open ? '' : 'collapsed'}" id="${id}">${contentHtml}</div>
        `;
        s.querySelector('.pg-section-head').onclick = function () {
          const c = s.querySelector('.pg-section-content');
          const arrow = s.querySelector('.pg-section-head span:last-child');
          c.classList.toggle('collapsed');
          arrow.textContent = c.classList.contains('collapsed') ? '▸' : '▾';
        };
        return s;
      }

      // Wizard section
      const wizardSec = section('🧙 Setup Wizard', 'pg-wizard-section', '<div id="pg-wizard-steps"></div>', true);
      body.appendChild(wizardSec);

      // Actions section
      const actionsSec = section('⚡ Actions', 'pg-actions-section', `
        <div class="pg-row">
          <button class="pg-btn pg-btn-green"  id="pg-run-org">▶ Organize Now</button>
          <button class="pg-btn pg-btn-yellow" id="pg-scan-win">🔍 Scan window</button>
          <button class="pg-btn pg-btn-blue"   id="pg-export-log">📥 Export Log</button>
        </div>
        <div class="pg-row" style="margin-top:4px">
          <button class="pg-btn pg-btn-gray" id="pg-copy-cfg">📋 Copy Config JSON</button>
        </div>
      `, true);
      body.appendChild(actionsSec);

      // Log section
      const logSec = section('📋 Event Log', 'pg-log-section', `
        <div id="pg-log"></div>
        <div class="pg-row" style="margin-top:4px">
          <button class="pg-btn pg-btn-red" id="pg-clear-log">Clear</button>
          <span id="pg-log-count" style="color:#6b7280;font-size:10px"></span>
        </div>
      `, true);
      body.appendChild(logSec);

      // Config section
      const cfgSec = section('⚙️ Config', 'pg-config-section', '<div id="pg-config-fields"></div>', false);
      body.appendChild(cfgSec);

      // Wire up actions
      panelEl.querySelector('#pg-close-btn').onclick = closePanel;
      panelEl.querySelector('#pg-min-btn').onclick = () => {
        const b = panelEl.querySelector('#pg-panel-body');
        b.style.display = b.style.display === 'none' ? '' : 'none';
      };
      panelEl.querySelector('#pg-run-org').onclick = () => organizeBoard();
      panelEl.querySelector('#pg-scan-win').onclick = () => scanWindow();
      panelEl.querySelector('#pg-export-log').onclick = () => exportLog();
      panelEl.querySelector('#pg-clear-log').onclick = () => { eventLog.length = 0; refreshLogPanel(); };
      panelEl.querySelector('#pg-copy-cfg').onclick = () => {
        navigator.clipboard.writeText(JSON.stringify(CFG, null, 2));
      };

      explorerOpen = true;
      startWatchers();
      rerenderWizard();
      refreshLogPanel();
      refreshConfigPanel();

      console.log('[PG] Explorer panel opened');
    }

    function closePanel() {
      if (panelEl) panelEl.style.display = 'none';
      explorerOpen = false;
      stopWatchers();
      console.log('[PG] Explorer panel closed');
    }

    // ── Drag ─────────────────────────────────────────────────────────────────
    function makeDraggable(el, handle) {
      handle.onmousedown = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const ox = rect.left - e.clientX;
        const oy = rect.top - e.clientY;
        const move = (e) => {
          el.style.left = `${e.clientX + ox}px`;
          el.style.top = `${e.clientY + oy}px`;
          el.style.right = 'auto';
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      };
    }

    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // KEYBIND: Alt+Shift+E toggles the explorer
    // ─────────────────────────────────────────────────────────────────────────
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && e.code === 'KeyE') {
        e.preventDefault();
        if (explorerOpen) {
          closePanel();
        } else {
          openPanel();
        }
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // BOOT
    // ─────────────────────────────────────────────────────────────────────────
    // Hook pass-turn silently in production mode if already configured
    hookPassTurn();
    hookPassTurnKey();

    console.log('[PG] Ready. Press Alt+Shift+E to open the explorer panel.');
    console.log('[PG] Current config:', CFG);
  }

})();
