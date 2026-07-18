// ==UserScript==
// @name         Playgroup.gg Auto-Organizer
// @namespace    https://playgroup.gg/
// @version      3.5.0
// @description  Auto-organizes your board on pass turn. Press F2 to open the explorer panel.
// @author       You
// @match        https://playgroup.gg/*
// @match        https://playgroup.gg/live_sessions/*
// @updateURL    https://raw.githubusercontent.com/joevanloon/PlaygroupGGMtgHelper/main/playgroup-explorer.user.js
// @downloadURL  https://raw.githubusercontent.com/joevanloon/PlaygroupGGMtgHelper/main/playgroup-explorer.user.js
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

// HOW TO USE:
//   Production mode: once configured, silently hooks pass_turn events and
//   auto-organizes your board.
//
//   Explorer mode: press F2 to toggle the diagnostic panel. It intercepts
//   the game's own WebSocket/GameChannel messages (including pass_turn,
//   move_card, etc.) and exports a full log for analysis.

console.log('[PG] Playgroup.gg Auto-Organizer v3.5 loading... URL:', location.href);

(function () {
  'use strict';

  console.log('[PG] Script IIFE started');

  // Use unsafeWindow when available (Tampermonkey) so we share the same JS
  // heap as the game code — critical for intercepting WebSocket and Vue/Phaser
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

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
    let _logLock = false; // prevent re-entrant log calls causing feedback loops

    function logEv(type, source, data) {
      if (_logLock) return;
      _logLock = true;
      try {
        const entry = {
          t: new Date().toISOString(),
          type,
          source: String(source).slice(0, 120),
          data,
        };
        eventLog.unshift(entry);
        if (eventLog.length > MAX_EVENTS) eventLog.pop();
        if (explorerOpen) refreshLogPanel();
        if (explorerOpen) console.log(`[PG:${type}]`, source, data);
      } finally {
        _logLock = false;
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GLOBAL WATCHERS — only active when explorer is open
    // ─────────────────────────────────────────────────────────────────────────
    let watchersActive = false;
    const patchedSymbol = Symbol('pg_patched');

    function startWatchers() {
      if (watchersActive) return;
      watchersActive = true;
      console.log('[PG] Starting global watchers');

      // ── Intercept fetch ───────────────────────────────────────────────────
      if (!win.fetch[patchedSymbol]) {
        const origFetch = win.fetch.bind(win);
        win.fetch = function (...args) {
          const url = String(args[0]?.url || args[0] || '');
          const method = String(args[1]?.method || 'GET');
          const body = args[1]?.body;
          logEv('FETCH', `${method} ${url}`, { body: body ? String(body).slice(0, 200) : null });
          return origFetch(...args);
        };
        win.fetch[patchedSymbol] = true;
      }

      // ── Intercept XHR ────────────────────────────────────────────────────
      if (!win.XMLHttpRequest.prototype[patchedSymbol]) {
        const origOpen = win.XMLHttpRequest.prototype.open;
        win.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
          this._pg_url = url;
          this._pg_method = method;
          return origOpen.call(this, method, url, ...rest);
        };
        const origSend = win.XMLHttpRequest.prototype.send;
        win.XMLHttpRequest.prototype.send = function (body) {
          logEv('XHR', `${this._pg_method} ${this._pg_url}`, { body: body ? String(body).slice(0, 200) : null });
          return origSend.call(this, body);
        };
        win.XMLHttpRequest.prototype[patchedSymbol] = true;
      }

      // ── Intercept WebSocket on unsafeWindow so we see the game's WS ──────
      if (!win.WebSocket[patchedSymbol]) {
        const OrigWS = win.WebSocket;
        function PatchedWS(url, protocols) {
          const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
          logEv('WS-OPEN', url, {});
          ws.addEventListener('message', (ev) => {
            try {
              const parsed = JSON.parse(ev.data);
              // GameChannel events come through as ActionCable messages
              // e.g. { type: 'message', message: { event_type: 'pass_turn', ... } }
              const eventType = parsed?.message?.event_type || parsed?.event_type || parsed?.type;
              logEv('WS-MSG', eventType || 'unknown', parsed);

              // Hook pass_turn directly by event name
              if (eventType === 'pass_turn') {
                logEv('PASS-TURN-DETECTED', 'gameChannel', parsed.message || parsed);
                if (CFG.autoOrganizeOnPassTurn) {
                  setTimeout(() => organizeBoard(), CFG.organizeDelay);
                }
              }

              // move_battlefield_card confirms organize worked — log it clearly
              if (eventType === 'move_battlefield_card' || eventType === 'move_card') {
                logEv('CARD-MOVED', eventType, {
                  cardId: parsed?.message?.card_id || parsed?.card_id,
                  zone: parsed?.message?.zone || parsed?.zone,
                });
              }
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
        win.WebSocket = PatchedWS;
      }

      // ── Intercept dispatchEvent ───────────────────────────────────────────
      if (!win.EventTarget.prototype.dispatchEvent[patchedSymbol]) {
        const origDispatch = win.EventTarget.prototype.dispatchEvent;
        win.EventTarget.prototype.dispatchEvent = function (event) {
          const skip = /^(mouse|pointer|touch|scroll|resize|focus|blur|input|change|transition|animation|drag|wheel|select)/i;
          const isOurPanel = this instanceof Element && this.closest?.('#pg-panel');
          if (!skip.test(event.type) && !isOurPanel) {
            logEv('DISPATCH', event.type, {
              target: selectorFor(this),
              detail: event.detail ?? null,
            });
          }
          return origDispatch.call(this, event);
        };
        win.EventTarget.prototype.dispatchEvent[patchedSymbol] = true;
      }

      // ── Click listener — log all clicks with selector ─────────────────────
      document._pg_clickListener = (e) => {
        if (captureClickActive) return;
        // Ignore clicks inside our own panel by checking the ID chain
        let el = e.target;
        while (el) { if (el.id === 'pg-panel') return; el = el.parentElement; }
        logEv('CLICK', selectorFor(e.target), {
          text: (e.target.textContent || '').trim().slice(0, 60),
          tag: e.target.tagName,
          class: String(e.target.className || ''),
        });
      };
      document.addEventListener('click', document._pg_clickListener, true);

      // ── Key listener ──────────────────────────────────────────────────────
      document._pg_keyListener = (e) => {
        if (captureKeyActive) return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        // Ignore keys from our panel
        let el = e.target;
        while (el) { if (el.id === 'pg-panel') return; el = el.parentElement; }
        logEv('KEYDOWN', e.code, { key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
      };
      document.addEventListener('keydown', document._pg_keyListener, true);

      // NOTE: DOM mutation observer intentionally omitted — it creates feedback
      // loops observing our own panel. WebSocket messages capture all game events.

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
    // Since cards are rendered on a Phaser canvas (not DOM elements), we
    // can't position them via CSS. Instead we:
    //   1. Try to call the Phaser scene's organize method directly (best)
    //   2. Try to click the organize button if it's visible in a context menu
    //   3. Try to call it via the Vue component proxy
    // ─────────────────────────────────────────────────────────────────────────
    function organizeBoard() {
      // ── Strategy 1: CardContextMenu Vue component direct call ─────────────
      const ctxResult = callContextMenuOrganize();
      if (ctxResult) return true;

      // ── Strategy 2: Phaser scene direct call ──────────────────────────────
      const phaserResult = callPhaserOrganize();
      if (phaserResult) return true;

      // ── Strategy 3: Click visible organize button (context menu in DOM) ───
      const btnResult = clickOrganizeButton();
      if (btnResult) return true;

      // ── Strategy 4: Vue component method ──────────────────────────────────
      const vueResult = callVueOrganize();
      if (vueResult) return true;

      console.log('[PG] organizeBoard: all strategies failed — open the explorer, run Deep Inspect, then Hook Keybindings');
      logEv('ORGANIZE-FAIL', 'no strategy succeeded', {});
      return false;
    }

    function callPhaserOrganize() {
      // Try known Phaser game locations
      try {
        const gameObj = win.__pg_phaserGame || win.game || win.Phaser?.game;
        if (!gameObj?.scene) return false;
        const scenes = gameObj.scene.scenes || [];
        for (const scene of scenes) {
          // Look for organize/arrange methods on the scene or its properties
          const organizeKeys = Object.getOwnPropertyNames(scene).filter(k =>
            /organiz|arrange|layout|sortCard/i.test(k) && typeof scene[k] === 'function'
          );
          if (organizeKeys.length) {
            console.log('[PG] Calling Phaser organize:', organizeKeys[0]);
            scene[organizeKeys[0]]();
            logEv('ORGANIZE', `phaser.scene.${organizeKeys[0]}`, {});
            return true;
          }
          // Also check nested managers on the scene
          for (const key of Object.keys(scene)) {
            const obj = scene[key];
            if (!obj || typeof obj !== 'object') continue;
            try {
              const subKeys = Object.getOwnPropertyNames(obj).filter(k =>
                /organiz|arrange|layout/i.test(k) && typeof obj[k] === 'function'
              );
              if (subKeys.length) {
                console.log(`[PG] Calling Phaser scene.${key}.${subKeys[0]}`);
                obj[subKeys[0]]();
                logEv('ORGANIZE', `phaser.scene.${key}.${subKeys[0]}`, {});
                return true;
              }
            } catch (_) {}
          }
        }
      } catch (e) { console.log('[PG] Phaser organize failed:', e); }
      return false;
    }

    function clickOrganizeButton() {
      // The captured selector is for the context menu button — only visible when open.
      if (CFG.organizeBtnSelector) {
        const btn = document.querySelector(CFG.organizeBtnSelector);
        // Make sure it's not inside our own panel
        if (btn && !btn.closest('#pg-panel')) {
          console.log('[PG] Clicking organize button:', CFG.organizeBtnSelector);
          btn.click();
          logEv('ORGANIZE', 'context-menu-btn', { selector: CFG.organizeBtnSelector });
          return true;
        }
      }
      // Search for any visible button with organize-related text, excluding our panel
      const allBtns = document.querySelectorAll('button, [role="button"]');
      for (const btn of allBtns) {
        if (btn.closest('#pg-panel')) continue; // never match our own UI
        const text = (btn.textContent || '').trim().toLowerCase();
        if (/organiz|arrange|sort.*card|tidy|clean.*up/.test(text)) {
          console.log('[PG] Found organize button by text:', text, selectorFor(btn));
          btn.click();
          logEv('ORGANIZE', 'text-match-btn', { text, selector: selectorFor(btn) });
          return true;
        }
      }
      return false;
    }

    // ── CardContextMenu Vue component hook ───────────────────────────────────
    // The game uses CardContextMenu.vue which emits menu-shown with menuKeys.
    // We intercept it to find the organize action and call it directly,
    // without needing to simulate right-click + visual menu navigation.
    let cardContextMenuProxy = null;

    function hookCardContextMenu() {
      // Walk all Vue component instances looking for CardContextMenu
      const found = findVueComponent(el => {
        // CardContextMenu logs "[PG Live][ContextMenu]" — look for that component
        const name = el.type?.name || el.type?.__name || '';
        return /CardContextMenu|ContextMenu/i.test(name);
      });

      if (!found) {
        console.log('[PG] CardContextMenu not found — try after opening a context menu');
        return false;
      }

      cardContextMenuProxy = found.proxy || found.ctx;
      console.log('[PG] Found CardContextMenu component, keys:', Object.keys(cardContextMenuProxy).slice(0, 30));
      win.__pg_contextMenu = cardContextMenuProxy;
      logEv('KBM-HOOK', 'CardContextMenu found', { keys: Object.keys(cardContextMenuProxy).slice(0, 30) });
      return true;
    }

    function callContextMenuOrganize() {
      const proxy = cardContextMenuProxy || win.__pg_contextMenu;
      if (!proxy) return false;
      // Look for organize-related methods
      const keys = Object.keys(proxy);
      const organizeKey = keys.find(k => /organiz|arrange|layout/i.test(k) && typeof proxy[k] === 'function');
      if (organizeKey) {
        console.log('[PG] Calling CardContextMenu organize:', organizeKey);
        proxy[organizeKey]();
        logEv('ORGANIZE', `contextMenu.${organizeKey}`, {});
        return true;
      }
      // Also check $refs and emits
      const emitFn = proxy.$emit;
      if (emitFn) {
        // Try emitting organize-related events
        for (const evt of ['organize', 'arrange', 'organizeBoard', 'arrange-board']) {
          try {
            proxy.$emit(evt);
            logEv('ORGANIZE', `contextMenu.$emit(${evt})`, {});
            console.log('[PG] Emitted:', evt);
            return true;
          } catch (_) {}
        }
      }
      return false;
    }

    function findVueComponent(predicate) {
      // Walk the Vue app's component tree looking for a component matching predicate
      const app = win.__pg_vueApp;
      if (!app) return null;
      const walk = (vnode, depth = 0) => {
        if (!vnode || depth > 15) return null;
        try {
          if (vnode.component && predicate(vnode.component)) return vnode.component;
          const c = vnode.component;
          if (c?.subTree) {
            const r = walk(c.subTree, depth + 1);
            if (r) return r;
          }
          const children = vnode.children;
          if (Array.isArray(children)) {
            for (const child of children) {
              const r = walk(child, depth + 1);
              if (r) return r;
            }
          } else if (children && typeof children === 'object') {
            for (const child of Object.values(children)) {
              if (child && typeof child === 'object') {
                const r = walk(child, depth + 1);
                if (r) return r;
              }
            }
          }
        } catch (_) {}
        return null;
      };
      try { return walk(app._instance?.subTree); } catch (_) { return null; }
    }

    function callVueOrganize() {
      try {
        const proxy = win.__pg_vueComponent;
        if (!proxy) return false;
        const organizeKeys = Object.keys(proxy).filter(k =>
          /organiz|arrange|layout/i.test(k) && typeof proxy[k] === 'function'
        );
        if (organizeKeys.length) {
          console.log('[PG] Calling Vue organize:', organizeKeys[0]);
          proxy[organizeKeys[0]]();
          logEv('ORGANIZE', `vue.${organizeKeys[0]}`, {});
          return true;
        }
      } catch (e) { console.log('[PG] Vue organize failed:', e); }
      return false;
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
      // Re-try on DOM changes — defer until body exists (script runs at document-start)
      const attachObs = () => {
        const target = document.body || document.documentElement;
        if (!target) { setTimeout(attachObs, 100); return; }
        const obs = new MutationObserver(tryHook);
        obs.observe(target, { childList: true, subtree: true });
      };
      attachObs();
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

    // ─────────────────────────────────────────────────────────────────────────
    // DEEP RUNTIME INSPECTOR
    // Walks the live JS heap to find Vue app, Phaser game, KeybindingManager,
    // StateManager, and any organize/arrange callable methods.
    // ─────────────────────────────────────────────────────────────────────────

    function scanWindow() {
      // Shallow keyword scan of window keys for quick overview
      const results = [];
      const scan = (obj, path, depth) => {
        if (depth > 2) return;
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
      scan(win, 'window', 0);
      logEv('WINDOW-SCAN', `Found ${results.length} game-related keys`, results);
      console.log('[PG] Window scan results:', results);
      refreshLogPanel();
    }

    function deepInspect() {
      const report = {
        vue: null,
        phaser: null,
        keybindingManager: null,
        stateManager: null,
        organizeMethods: [],
        passTurnMethods: [],
        allGameObjects: [],
      };

      // ── 1. Find Vue 3 app instance ────────────────────────────────────────
      // Vue 3 mounts onto a DOM element and exposes .__vue_app__
      try {
        const vueRoots = [...document.querySelectorAll('[data-v-app], #app, #game-app, [id*="app"], canvas')];
        for (const el of vueRoots) {
          if (el.__vue_app__) {
            report.vue = { found: true, element: el.id || el.tagName };
            const vueApp = el.__vue_app__;
            win.__pg_vueApp = vueApp; // Save for findVueComponent()
            // Walk component tree
            const walkComponent = (vnode, depth = 0) => {
              if (!vnode || depth > 6) return;
              try {
                const component = vnode.component;
                if (component) {
                  const proxy = component.proxy || component.ctx;
                  if (proxy) {
                    // Look for organize/arrange/passTurn methods on component proxy
                    const keys = Object.keys(proxy).concat(
                      Object.getOwnPropertyNames(Object.getPrototypeOf(proxy) || {})
                    );
                    keys.forEach(k => {
                      try {
                        const v = proxy[k];
                        if (typeof v === 'function') {
                          if (/organiz|arrange|sort.*card|card.*sort/i.test(k)) {
                            report.organizeMethods.push({ path: `vue.component.${k}`, fn: String(v).slice(0, 150) });
                          }
                          if (/passTurn|pass_turn|endTurn|end_turn|nextTurn|next_turn/i.test(k)) {
                            report.passTurnMethods.push({ path: `vue.component.${k}`, fn: String(v).slice(0, 150) });
                          }
                          if (/game|board|card|zone|battlefield|hand|library|state|manager|channel/i.test(k)) {
                            report.allGameObjects.push({ path: `vue.component.${k}`, type: typeof v });
                          }
                        } else if (v && typeof v === 'object') {
                          if (/game|board|state|manager|channel/i.test(k)) {
                            report.allGameObjects.push({ path: `vue.component.${k}`, type: 'object', keys: Object.keys(v).slice(0, 20) });
                          }
                        }
                      } catch (_) {}
                    });

                    // Store reference for interactive use
                    win.__pg_vueComponent = proxy;
                  }
                  // Recurse into children
                  const subTree = component.subTree;
                  if (subTree) {
                    walkComponent(subTree, depth + 1);
                    if (subTree.children) {
                      (Array.isArray(subTree.children) ? subTree.children : [subTree.children])
                        .forEach(child => walkComponent(child, depth + 1));
                    }
                  }
                }
                if (vnode.children) {
                  (Array.isArray(vnode.children) ? vnode.children : [vnode.children])
                    .forEach(child => walkComponent(child, depth + 1));
                }
              } catch (_) {}
            };
            try { walkComponent(vueApp._instance?.subTree); } catch (_) {}
            break;
          }
        }
      } catch (e) { report.vue = { error: String(e) }; }

      // ── 2. Find Phaser game instance ──────────────────────────────────────
      try {
        // Step 1: locate the game object via multiple strategies
        let phaserGame = win.__pg_phaserGame || win.Phaser?.game || win.__PHASER_GAME__ || win.game;

        if (!phaserGame?.scene) {
          // Phaser 3 adds a non-enumerable reference on the canvas element
          for (const c of document.querySelectorAll('canvas')) {
            for (const k of Object.getOwnPropertyNames(c)) {
              try {
                const v = c[k];
                if (v && typeof v === 'object' && v.scene && v.loop) {
                  phaserGame = v;
                  console.log('[PG] Found Phaser game on canvas property:', k);
                  break;
                }
              } catch (_) {}
            }
            if (phaserGame?.scene) break;
          }
        }

        if (!phaserGame?.scene) {
          // Check common window-level names
          for (const k of ['__PHASER_GAME__', '__game', '_game', 'phaserGame', 'GAME', 'g']) {
            if (win[k]?.scene) { phaserGame = win[k]; break; }
          }
        }

        if (phaserGame?.scene) {
          win.__pg_phaserGame = phaserGame;
          report.phaser = { found: true, sceneCount: phaserGame.scene.scenes?.length };

          // Step 2: walk all scenes and their properties
          const walkScene = (scene, sceneName) => {
            const PHASER_INTERNALS = /^(sys|events|input|tweens|time|physics|cameras|add|make|scale|scene|anims|sound|data|plugins|registry|textures|renderer|cache|loader|children|displayList|updateList|game|lights|matter)$/;
            const allKeys = [];
            let proto = scene;
            // Walk prototype chain to get all inherited methods too
            while (proto && proto !== Object.prototype) {
              allKeys.push(...Object.getOwnPropertyNames(proto));
              proto = Object.getPrototypeOf(proto);
            }
            const seen = new Set();
            for (const k of allKeys) {
              if (seen.has(k) || PHASER_INTERNALS.test(k) || k.startsWith('_')) continue;
              seen.add(k);
              try {
                const v = scene[k];
                if (typeof v === 'function') {
                  if (/organiz|arrange|sort.*card|layout.*card|tidy/i.test(k)) {
                    report.organizeMethods.push({ path: `phaser.${sceneName}.${k}`, fn: String(v).slice(0, 200) });
                  }
                  if (/passTurn|endTurn|nextTurn|pass_turn|end_turn/i.test(k)) {
                    report.passTurnMethods.push({ path: `phaser.${sceneName}.${k}`, fn: String(v).slice(0, 200) });
                  }
                  if (/card|board|zone|hand|battlefield|permanent|state|manager|channel/i.test(k)) {
                    report.allGameObjects.push({ path: `phaser.${sceneName}.${k}`, type: 'function' });
                  }
                } else if (v && typeof v === 'object') {
                  if (/card|board|zone|hand|state|manager|channel|permanent/i.test(k)) {
                    const subKeys = Object.keys(v).slice(0, 30);
                    report.allGameObjects.push({ path: `phaser.${sceneName}.${k}`, type: 'object', subKeys });
                    win[`__pg_${sceneName}_${k}`] = v;
                    // Scan one level deeper for organize methods
                    for (const sk of Object.keys(v)) {
                      if (typeof v[sk] === 'function' && /organiz|arrange|layout/i.test(sk)) {
                        report.organizeMethods.push({ path: `phaser.${sceneName}.${k}.${sk}`, fn: String(v[sk]).slice(0, 200) });
                      }
                    }
                  }
                }
              } catch (_) {}
            }
            win[`__pg_scene_${sceneName}`] = scene;
          };

          (phaserGame.scene.scenes || []).forEach((scene, i) => {
            const sceneName = scene.sys?.settings?.key || `scene_${i}`;
            walkScene(scene, sceneName);
          });
        } else {
          report.phaser = { found: false, note: 'Could not locate Phaser game object' };
        }
      } catch (e) { report.phaser = { error: String(e) }; }

      // ── 3. Hunt for KeybindingManager in all window objects ───────────────
      try {
        const huntObj = (obj, path, depth = 0, visited = new WeakSet()) => {
          if (depth > 4 || !obj || typeof obj !== 'object') return;
          if (visited.has(obj)) return;
          visited.add(obj);
          try {
            const keys = Object.keys(obj);
            for (const k of keys) {
              try {
                const v = obj[k];
                const p = `${path}.${k}`;
                if (v && typeof v === 'object') {
                  // KeybindingManager has a registerBinding / getBindings type method
                  if (typeof v.registerBinding === 'function' || typeof v.getBindings === 'function' ||
                      typeof v.register === 'function' && typeof v.handle === 'function') {
                    report.keybindingManager = { path: p, keys: Object.keys(v).slice(0, 30) };
                    win.__pg_keybindingManager = v;
                  }
                  // StateManager
                  if (typeof v.getState === 'function' || typeof v.setState === 'function' ||
                      (typeof v.state === 'object' && typeof v.dispatch === 'function')) {
                    report.stateManager = { path: p, keys: Object.keys(v).slice(0, 30) };
                    win.__pg_stateManager = v;
                  }
                  if (depth < 3) huntObj(v, p, depth + 1, visited);
                }
              } catch (_) {}
            }
          } catch (_) {}
        };
        huntObj(win, 'window', 0);
      } catch (e) {}

      // ── 4. Check if Vue component is accessible via $root / $app ─────────
      try {
        if (win.__pg_vueComponent) {
          const root = win.__pg_vueComponent.$root || win.__pg_vueComponent;
          // Look for $refs, $data deeply
          const data = root.$data || {};
          Object.keys(data).forEach(k => {
            const v = data[k];
            if (v && typeof v === 'object') {
              // Check for organize/arrange on nested objects
              const subKeys = typeof v === 'object' ? Object.keys(v) : [];
              subKeys.forEach(sk => {
                if (typeof v[sk] === 'function' && /organiz|arrange|layout|sort/i.test(sk)) {
                  report.organizeMethods.push({ path: `vue.$data.${k}.${sk}`, fn: String(v[sk]).slice(0, 150) });
                }
              });
            }
          });
        }
      } catch (_) {}

      // Summary
      console.log('[PG] Deep inspect report:', report);
      console.log('[PG] References saved: window.__pg_vueComponent, window.__pg_stateManager, window.__pg_keybindingManager, window.__pg_scene_*');

      logEv('DEEP-INSPECT', `Vue:${!!report.vue?.found} Phaser:${!!report.phaser?.found} KBM:${!!report.keybindingManager} SM:${!!report.stateManager} Organize:${report.organizeMethods.length} PassTurn:${report.passTurnMethods.length} GameObjs:${report.allGameObjects.length}`, report);
      refreshLogPanel();
      return report;
    }

    function hookKeybindingManager() {
      // Intercept KeybindingManager by patching EventTarget.dispatchEvent for
      // the specific events the KBM logs: 'context-result' and 'unhandled'
      // We saw these in the console: [PG Live][KeybindingManager] context-result
      // Strategy: find the KBM instance and wrap its handler method

      const kbm = win.__pg_keybindingManager;
      if (!kbm) {
        // Try to find it by looking for objects that have been logged to console
        // with [PG Live][KeybindingManager] prefix — scan for the pattern
        logEv('KBM-HOOK', 'Not found yet — run Deep Inspect first, then try again', {});
        return;
      }

      // Wrap every function on the KBM to log calls
      const wrapped = [];
      Object.keys(kbm).forEach(k => {
        if (typeof kbm[k] === 'function') {
          const orig = kbm[k].bind(kbm);
          kbm[k] = function (...args) {
            logEv('KBM-CALL', k, { args: JSON.stringify(args).slice(0, 200) });
            // If this looks like an organize action, capture it
            const argStr = JSON.stringify(args).toLowerCase();
            if (/organiz|arrange|layout|sort/.test(argStr)) {
              logEv('KBM-ORGANIZE', k, { args: argStr });
              win.__pg_organizeCall = { method: k, args };
            }
            return orig(...args);
          };
          wrapped.push(k);
        }
      });
      logEv('KBM-HOOK', `Wrapped ${wrapped.length} KBM methods`, { methods: wrapped });
      console.log('[PG] KeybindingManager hooked:', wrapped);
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
            <div class="hint">F2 to toggle</div>
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
          <button class="pg-btn pg-btn-blue"   id="pg-export-log">📥 Export Log</button>
        </div>
        <div class="pg-row" style="margin-top:4px">
          <button class="pg-btn pg-btn-yellow" id="pg-scan-win">🔍 Shallow Scan</button>
          <button class="pg-btn pg-btn-yellow" id="pg-deep-inspect">🔬 Deep Inspect</button>
        </div>
        <div class="pg-row" style="margin-top:4px">
          <button class="pg-btn pg-btn-gray"   id="pg-hook-ctx">🪝 Hook Context Menu</button>
          <button class="pg-btn pg-btn-gray"   id="pg-hook-kbm">🪝 Hook Keybindings</button>
          <button class="pg-btn pg-btn-gray"   id="pg-copy-cfg">📋 Copy Config JSON</button>
        </div>
        <div style="color:#6b7280;font-size:10px;margin-top:4px">
          After Deep Inspect: window.__pg_vueComponent, __pg_stateManager, __pg_keybindingManager, __pg_scene_* available in console
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
      panelEl.querySelector('#pg-deep-inspect').onclick = () => deepInspect();
      panelEl.querySelector('#pg-hook-ctx').onclick = () => hookCardContextMenu();
      panelEl.querySelector('#pg-hook-kbm').onclick = () => hookKeybindingManager();
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
    // KEYBIND: F2 toggles the explorer
    // Use capture:true at window level so we fire BEFORE KeybindingManager
    // ─────────────────────────────────────────────────────────────────────────
    win.addEventListener('keydown', (e) => {
      if (e.code === 'F2') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (explorerOpen) {
          closePanel();
        } else {
          openPanel();
        }
      }
    }, true);

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
