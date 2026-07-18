// ==UserScript==
// @name         Playgroup.gg Auto-Organizer
// @namespace    https://playgroup.gg/
// @version      4.0.0
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
//   Explorer mode: press F2 to toggle the diagnostic panel.
//   Key features:
//     - "Hook Capture" mode: manually click the organize button while active
//       and the script records the exact call chain for reliable replay.
//     - "Extract Sources": downloads all loaded JS + analysis so you can
//       inspect exactly how organize works offline.
//     - "Export Diagnostic": full bundle — sources, DOM, config, event log.

console.log('[PG] Playgroup.gg Auto-Organizer v4.0 loading... URL:', location.href);

(function () {
  'use strict';

  console.log('[PG] Script IIFE started');

  // Use unsafeWindow when available (Tampermonkey) so we share the same JS
  // heap as the game code — critical for intercepting WebSocket and Vue/Phaser
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  try {
    main();
  } catch (err) {
    console.error('[PG] Fatal error during init:', err);
  }

  function main() {
    console.log('[PG] main() called, URL:', location.href);

    // ─────────────────────────────────────────────────────────────────────────
    // STORAGE
    // ─────────────────────────────────────────────────────────────────────────
    const STORAGE_KEY = 'pg_ao_config_v3';

    const DEFAULTS = {
      passTurnSelector:    null,
      organizeBtnSelector: null,
      boardSelector:       null,
      cardSelector:        null,
      autoOrganizeOnPassTurn: true,
      organizeDelay:       300,
      // Learned from Hook Capture:
      learnedOrganizeCall: null, // { type: 'vue-method'|'vue-emit'|'phaser', path, args }
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
    let _logLock = false;

    function logEv(type, source, data) {
      if (_logLock) return;
      _logLock = true;
      try {
        const entry = { t: new Date().toISOString(), type, source: String(source).slice(0, 120), data };
        eventLog.unshift(entry);
        if (eventLog.length > MAX_EVENTS) eventLog.pop();
        if (explorerOpen) refreshLogPanel();
        if (explorerOpen) console.log(`[PG:${type}]`, source, data);
      } finally {
        _logLock = false;
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GLOBAL WATCHERS
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

      // ── Intercept WebSocket ───────────────────────────────────────────────
      if (!win.WebSocket[patchedSymbol]) {
        const OrigWS = win.WebSocket;
        function PatchedWS(url, protocols) {
          const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
          logEv('WS-OPEN', url, {});

          // Store all live WebSocket instances so we can potentially send on them
          if (!win.__pg_wsSockets) win.__pg_wsSockets = [];
          win.__pg_wsSockets.push(ws);

          ws.addEventListener('message', (ev) => {
            try {
              const parsed = JSON.parse(ev.data);
              const eventType = parsed?.message?.event_type || parsed?.event_type || parsed?.type;
              logEv('WS-MSG', eventType || 'unknown', parsed);

              // Hook pass_turn via WebSocket (fires even without UI interaction)
              if (eventType === 'pass_turn') {
                logEv('PASS-TURN-DETECTED', 'gameChannel', parsed.message || parsed);
                if (CFG.autoOrganizeOnPassTurn) {
                  setTimeout(() => organizeBoard(), CFG.organizeDelay);
                }
              }

              if (eventType === 'move_battlefield_card' || eventType === 'move_card') {
                logEv('CARD-MOVED', eventType, {
                  cardId: parsed?.message?.card_id || parsed?.card_id,
                  zone: parsed?.message?.zone || parsed?.zone,
                });
              }

              // Store GameChannel subscription identifiers for emitting events back
              if (parsed?.identifier) {
                try {
                  const id = JSON.parse(parsed.identifier);
                  if (id?.channel) win.__pg_wsChannelId = parsed.identifier;
                } catch (_) {}
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
        Object.defineProperty(PatchedWS, 'OPEN',       { get: () => OrigWS.OPEN });
        Object.defineProperty(PatchedWS, 'CLOSING',    { get: () => OrigWS.CLOSING });
        Object.defineProperty(PatchedWS, 'CLOSED',     { get: () => OrigWS.CLOSED });
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
            logEv('DISPATCH', event.type, { target: selectorFor(this), detail: event.detail ?? null });
          }
          return origDispatch.call(this, event);
        };
        win.EventTarget.prototype.dispatchEvent[patchedSymbol] = true;
      }

      // ── Click listener ────────────────────────────────────────────────────
      document._pg_clickListener = (e) => {
        if (captureClickActive) return;
        let el = e.target;
        while (el) { if (el.id === 'pg-panel') return; el = el.parentElement; }
        logEv('CLICK', selectorFor(e.target), {
          text: (e.target.textContent || '').trim().slice(0, 60),
          tag: e.target.tagName,
          class: String(e.target.className || ''),
        });
      };
      document.addEventListener('click', document._pg_clickListener, true);

      console.log('[PG] All watchers active');
    }

    function stopWatchers() {
      if (!watchersActive) return;
      watchersActive = false;
      if (document._pg_clickListener) {
        document.removeEventListener('click', document._pg_clickListener, true);
      }
      console.log('[PG] Watchers stopped (fetch/XHR/WS/dispatchEvent patches remain until page reload)');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SELECTOR BUILDER
    // ─────────────────────────────────────────────────────────────────────────
    function selectorFor(el) {
      if (!el || el === document || el === window || el === document.body) return '(body)';
      if (el.nodeType !== 1) return '(non-element)';
      if (el.id) return `#${el.id}`;
      const parts = [];
      let cur = el;
      let depth = 0;
      while (cur && cur !== document.body && depth < 6) {
        if (cur.id) { parts.unshift(`#${cur.id}`); break; }
        let part = cur.tagName.toLowerCase();
        const dataCard = cur.getAttribute?.('data-card-id') || cur.getAttribute?.('data-card') || cur.getAttribute?.('data-permanent-id');
        const dataZone = cur.getAttribute?.('data-zone');
        const dataAction = cur.getAttribute?.('data-action');
        if (dataCard) { parts.unshift(`[data-card-id="${dataCard}"]`); break; }
        if (dataZone) part += `[data-zone="${dataZone}"]`;
        else if (dataAction) part += `[data-action="${dataAction}"]`;
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
    // ELEMENT CAPTURE
    // ─────────────────────────────────────────────────────────────────────────
    let captureClickActive = false;
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

    // ─────────────────────────────────────────────────────────────────────────
    // BOARD ORGANIZER — tries strategies in order
    // ─────────────────────────────────────────────────────────────────────────
    function organizeBoard() {
      // ── Strategy 0: Replay a previously learned call (most reliable) ──────
      if (CFG.learnedOrganizeCall) {
        const ok = replayLearnedCall(CFG.learnedOrganizeCall);
        if (ok) return true;
      }

      // ── Strategy 1: CardContextMenu Vue component direct call ─────────────
      if (callContextMenuOrganize()) return true;

      // ── Strategy 2: Phaser scene direct call ──────────────────────────────
      if (callPhaserOrganize()) return true;

      // ── Strategy 3: Click visible organize button (context menu in DOM) ───
      if (clickOrganizeButton()) return true;

      // ── Strategy 4: Vue component method ──────────────────────────────────
      if (callVueOrganize()) return true;

      // ── Strategy 5: Emit via GameChannel WebSocket ────────────────────────
      if (emitOrganizeViaWS()) return true;

      console.log('[PG] organizeBoard: all strategies failed — open the explorer, run Hook Capture');
      logEv('ORGANIZE-FAIL', 'no strategy succeeded', {});
      return false;
    }

    // ── Strategy 0: Replay learned call ──────────────────────────────────────
    function replayLearnedCall(call) {
      try {
        if (call.type === 'vue-method') {
          // Resolve the path from the saved component reference
          const proxy = win.__pg_vueComponent;
          if (!proxy) return false;
          const fn = resolvePath(proxy, call.path);
          if (typeof fn === 'function') {
            fn.apply(proxy, call.args || []);
            logEv('ORGANIZE', `learned.vue-method.${call.path}`, {});
            return true;
          }
        }
        if (call.type === 'vue-emit') {
          const proxy = win.__pg_vueComponent;
          if (!proxy?.$emit) return false;
          proxy.$emit(call.event, ...(call.args || []));
          logEv('ORGANIZE', `learned.vue-emit.${call.event}`, {});
          return true;
        }
        if (call.type === 'context-menu-method') {
          const proxy = cardContextMenuProxy || win.__pg_contextMenu;
          if (!proxy) return false;
          const fn = resolvePath(proxy, call.path);
          if (typeof fn === 'function') {
            fn.apply(proxy, call.args || []);
            logEv('ORGANIZE', `learned.ctx-method.${call.path}`, {});
            return true;
          }
        }
        if (call.type === 'direct-fn') {
          // A captured raw function stored on window
          const fn = win.__pg_learnedFn;
          if (typeof fn === 'function') {
            fn();
            logEv('ORGANIZE', 'learned.direct-fn', {});
            return true;
          }
        }
      } catch (e) {
        console.log('[PG] Learned call failed:', e);
        logEv('ORGANIZE-WARN', 'learned call threw', { err: String(e) });
      }
      return false;
    }

    function resolvePath(obj, path) {
      return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
    }

    // ── Strategy 1: CardContextMenu component ─────────────────────────────────
    let cardContextMenuProxy = null;

    function hookCardContextMenu() {
      const found = findVueComponent(el => {
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
      logEv('CTX-HOOK', 'CardContextMenu found', { keys: Object.keys(cardContextMenuProxy).slice(0, 30) });
      return true;
    }

    function callContextMenuOrganize() {
      const proxy = cardContextMenuProxy || win.__pg_contextMenu;
      if (!proxy) return false;
      const keys = Object.keys(proxy);
      const organizeKey = keys.find(k => /organiz|arrange|layout/i.test(k) && typeof proxy[k] === 'function');
      if (organizeKey) {
        console.log('[PG] Calling CardContextMenu organize:', organizeKey);
        proxy[organizeKey]();
        logEv('ORGANIZE', `contextMenu.${organizeKey}`, {});
        return true;
      }
      return false;
    }

    // ── Strategy 2: Phaser direct call ────────────────────────────────────────
    function callPhaserOrganize() {
      try {
        const gameObj = win.__pg_phaserGame || win.game || win.Phaser?.game;
        if (!gameObj?.scene) return false;
        for (const scene of (gameObj.scene.scenes || [])) {
          const organizeKeys = Object.getOwnPropertyNames(scene).filter(k =>
            /organiz|arrange|layout|sortCard/i.test(k) && typeof scene[k] === 'function'
          );
          if (organizeKeys.length) {
            console.log('[PG] Calling Phaser organize:', organizeKeys[0]);
            scene[organizeKeys[0]]();
            logEv('ORGANIZE', `phaser.scene.${organizeKeys[0]}`, {});
            return true;
          }
          for (const key of Object.keys(scene)) {
            const obj = scene[key];
            if (!obj || typeof obj !== 'object') continue;
            try {
              const subKeys = Object.getOwnPropertyNames(obj).filter(k =>
                /organiz|arrange|layout/i.test(k) && typeof obj[k] === 'function'
              );
              if (subKeys.length) {
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

    // ── Strategy 3: Click visible button ─────────────────────────────────────
    function clickOrganizeButton() {
      if (CFG.organizeBtnSelector) {
        const btn = document.querySelector(CFG.organizeBtnSelector);
        if (btn && !btn.closest('#pg-panel')) {
          btn.click();
          logEv('ORGANIZE', 'context-menu-btn', { selector: CFG.organizeBtnSelector });
          return true;
        }
      }
      const allBtns = document.querySelectorAll('button, [role="button"]');
      for (const btn of allBtns) {
        if (btn.closest('#pg-panel')) continue;
        const text = (btn.textContent || '').trim().toLowerCase();
        if (/organiz|arrange|sort.*card|tidy|clean.*up/.test(text)) {
          btn.click();
          logEv('ORGANIZE', 'text-match-btn', { text, selector: selectorFor(btn) });
          return true;
        }
      }
      return false;
    }

    // ── Strategy 4: Vue component method ─────────────────────────────────────
    function findVueComponent(predicate) {
      const app = win.__pg_vueApp;
      if (!app) return null;
      const walk = (vnode, depth = 0) => {
        if (!vnode || depth > 15) return null;
        try {
          if (vnode.component && predicate(vnode.component)) return vnode.component;
          const c = vnode.component;
          if (c?.subTree) { const r = walk(c.subTree, depth + 1); if (r) return r; }
          const children = vnode.children;
          if (Array.isArray(children)) {
            for (const child of children) { const r = walk(child, depth + 1); if (r) return r; }
          } else if (children && typeof children === 'object') {
            for (const child of Object.values(children)) {
              if (child && typeof child === 'object') { const r = walk(child, depth + 1); if (r) return r; }
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
          proxy[organizeKeys[0]]();
          logEv('ORGANIZE', `vue.${organizeKeys[0]}`, {});
          return true;
        }
      } catch (e) { console.log('[PG] Vue organize failed:', e); }
      return false;
    }

    // ── Strategy 5: Emit organize event via WebSocket (GameChannel) ──────────
    function emitOrganizeViaWS() {
      try {
        const sockets = (win.__pg_wsSockets || []).filter(ws => ws.readyState === 1 /* OPEN */);
        if (!sockets.length) return false;
        const channelId = win.__pg_wsChannelId;
        if (!channelId) return false;
        // ActionCable message format
        const msg = JSON.stringify({
          command: 'message',
          identifier: channelId,
          data: JSON.stringify({ action: 'organize_battlefield' }),
        });
        sockets[0].send(msg);
        logEv('ORGANIZE', 'ws-emit.organize_battlefield', {});
        return true;
      } catch (e) { console.log('[PG] WS emit organize failed:', e); }
      return false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HOOK CAPTURE — intercept all method calls while you manually click
    // the organize button, then record the exact invocation for replay
    // ─────────────────────────────────────────────────────────────────────────
    let hookCaptureActive = false;
    let hookCapturePatches = []; // { obj, key, orig } for cleanup

    function startHookCapture(onResult) {
      if (hookCaptureActive) return;
      hookCaptureActive = true;
      hookCapturePatches = [];

      logEv('HOOK-CAPTURE', 'started', {});
      console.log('[PG] Hook Capture started — now right-click a card and click "Auto organise battlefield"');

      const foundCalls = [];

      // Wrap Vue component methods
      const patchVue = (proxy, label) => {
        if (!proxy || typeof proxy !== 'object') return;
        const keys = [...Object.keys(proxy)];
        for (const k of keys) {
          try {
            if (typeof proxy[k] !== 'function') continue;
            // Only patch methods that sound relevant to game actions
            if (!/organiz|arrange|layout|action|emit|perform|execute|trigger|battlefield|card|board/i.test(k)) continue;
            const orig = proxy[k].bind(proxy);
            proxy[k] = function (...args) {
              const entry = { label: `${label}.${k}`, args: safeSerialize(args) };
              foundCalls.push(entry);
              logEv('HOOK-CAPTURE-CALL', entry.label, { args: entry.args });
              console.log(`[PG] Hook captured: ${entry.label}`, args);
              return orig(...args);
            };
            hookCapturePatches.push({ obj: proxy, key: k, orig: proxy[k] });
          } catch (_) {}
        }
      };

      // Wrap Vue app + all components
      try {
        const vueApp = win.__pg_vueApp;
        if (vueApp) {
          const walkAndPatch = (vnode, depth = 0) => {
            if (!vnode || depth > 10) return;
            try {
              const c = vnode.component;
              if (c) {
                const proxy = c.proxy || c.ctx;
                const name = c.type?.name || c.type?.__name || `comp_${depth}`;
                if (proxy) patchVue(proxy, `vue.${name}`);
                if (c.subTree) walkAndPatch(c.subTree, depth + 1);
              }
              const children = vnode.children;
              if (Array.isArray(children)) children.forEach(ch => walkAndPatch(ch, depth + 1));
              else if (children && typeof children === 'object')
                Object.values(children).forEach(ch => ch && typeof ch === 'object' && walkAndPatch(ch, depth + 1));
            } catch (_) {}
          };
          walkAndPatch(vueApp._instance?.subTree);
        }
      } catch (e) { console.log('[PG] Hook Capture Vue patch error:', e); }

      // Wrap Phaser scene methods
      try {
        const game = win.__pg_phaserGame;
        if (game?.scene?.scenes) {
          for (const scene of game.scene.scenes) {
            const name = scene.sys?.settings?.key || 'scene';
            // Walk prototype chain
            let proto = scene;
            while (proto && proto !== Object.prototype) {
              for (const k of Object.getOwnPropertyNames(proto)) {
                try {
                  if (k.startsWith('_') || k === 'constructor') continue;
                  if (typeof scene[k] !== 'function') continue;
                  if (!/organiz|arrange|layout|action|card|board|battlefield/i.test(k)) continue;
                  const orig = scene[k].bind(scene);
                  scene[k] = function (...args) {
                    const entry = { label: `phaser.${name}.${k}`, args: safeSerialize(args) };
                    foundCalls.push(entry);
                    logEv('HOOK-CAPTURE-CALL', entry.label, { args: entry.args });
                    return orig(...args);
                  };
                  hookCapturePatches.push({ obj: scene, key: k, orig: orig });
                } catch (_) {}
              }
              proto = Object.getPrototypeOf(proto);
            }
          }
        }
      } catch (e) { console.log('[PG] Hook Capture Phaser patch error:', e); }

      // Set up a timeout — after 30s, stop and report
      const timeout = setTimeout(() => {
        stopHookCapture();
        onResult(foundCalls);
      }, 30000);

      // Also watch dispatchEvent for game-specific events
      const origDispatch = win.EventTarget.prototype.dispatchEvent;
      const captureDispatch = function (event) {
        if (!/organiz|arrange|action/i.test(event.type)) return origDispatch.call(this, event);
        foundCalls.push({ label: `dispatch.${event.type}`, args: [event.detail] });
        logEv('HOOK-CAPTURE-DISPATCH', event.type, { detail: event.detail });
        return origDispatch.call(this, event);
      };
      win.EventTarget.prototype.dispatchEvent = captureDispatch;
      hookCapturePatches.push({
        obj: win.EventTarget.prototype, key: 'dispatchEvent',
        orig: origDispatch,
      });

      // Expose a manual stop function
      win.__pg_stopCapture = () => {
        clearTimeout(timeout);
        stopHookCapture();
        onResult(foundCalls);
      };
    }

    function stopHookCapture() {
      if (!hookCaptureActive) return;
      hookCaptureActive = false;
      // Restore all patched methods
      for (const { obj, key, orig } of hookCapturePatches) {
        try { obj[key] = orig; } catch (_) {}
      }
      hookCapturePatches = [];
      delete win.__pg_stopCapture;
      logEv('HOOK-CAPTURE', 'stopped', {});
      console.log('[PG] Hook Capture stopped');
    }

    function safeSerialize(args) {
      try {
        return JSON.parse(JSON.stringify(args, (k, v) => {
          if (typeof v === 'function') return '[Function]';
          if (typeof v === 'object' && v !== null && Object.keys(v).length > 50) return '[LargeObject]';
          return v;
        }));
      } catch (_) {
        return args.map(a => String(a).slice(0, 100));
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SOURCE EXTRACTION
    // Collects all loaded JS sources from <script> tags + performance entries
    // ─────────────────────────────────────────────────────────────────────────
    async function extractGameSources() {
      logEv('EXTRACT', 'starting source extraction', {});
      const sources = [];

      // 1. Inline <script> blocks
      const inlineScripts = document.querySelectorAll('script:not([src])');
      let inlineIdx = 0;
      for (const s of inlineScripts) {
        const content = s.textContent || '';
        if (content.trim().length < 50) continue; // skip tiny/empty
        sources.push({
          type: 'inline',
          id: `inline_${inlineIdx++}`,
          url: null,
          size: content.length,
          content,
        });
      }

      // 2. External <script src=""> — fetch each one
      const externalScripts = [...document.querySelectorAll('script[src]')];
      const fetches = externalScripts.map(async (s) => {
        const url = s.src;
        if (!url || url.startsWith('chrome-extension')) return null;
        try {
          const r = await fetch(url, { credentials: 'same-origin' });
          const content = await r.text();
          return { type: 'external', url, size: content.length, content };
        } catch (e) {
          return { type: 'external-failed', url, error: String(e), content: null };
        }
      });

      const results = await Promise.all(fetches);
      for (const r of results) { if (r) sources.push(r); }

      // 3. Performance resource entries (catches dynamically loaded scripts)
      try {
        const perfEntries = performance.getEntriesByType('resource')
          .filter(e => e.initiatorType === 'script' && !sources.some(s => s.url === e.name));
        for (const entry of perfEntries) {
          try {
            const r = await fetch(entry.name, { credentials: 'same-origin' });
            const content = await r.text();
            sources.push({ type: 'perf-script', url: entry.name, size: content.length, content });
          } catch (e) {
            sources.push({ type: 'perf-script-failed', url: entry.name, error: String(e), content: null });
          }
        }
      } catch (_) {}

      logEv('EXTRACT', `extracted ${sources.length} sources`, { sizes: sources.map(s => ({ url: (s.url || s.id || '?').slice(-60), size: s.size })) });
      console.log('[PG] Extracted', sources.length, 'sources');
      return sources;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SOURCE ANALYSIS — search extracted sources for organize-related code
    // ─────────────────────────────────────────────────────────────────────────
    function analyzeSourcesForOrganize(sources) {
      const findings = [];

      const patterns = [
        // Function definitions
        { label: 'fn:organiz',       re: /function\s+\w*[Oo]rgani[sz]\w*\s*\(/ },
        { label: 'fn:arrangeBattlefield', re: /function\s+\w*[Aa]rrange\w*\s*\(/ },
        { label: 'fn:sortCards',     re: /function\s+\w*[Ss]ort\w*[Cc]ard\w*\s*\(/ },
        // Method/property assignments
        { label: 'method:organiz',   re: /[a-zA-Z_$][\w$]*\s*[:=]\s*(?:async\s+)?function[^(]*\([^)]*\)[^{]*\{[^}]*organiz/i },
        // Vue method names
        { label: 'vue:organiz',      re: /organiz\w*\s*\(\s*\)\s*\{/ },
        { label: 'vue:arrange',      re: /arrange\w*\s*\(\s*\)\s*\{/ },
        // Keyword near action strings
        { label: 'str:organize_battlefield', re: /['"` ]organize[_-]?battlefield['"` ]/i },
        { label: 'str:auto.organis', re: /['"` ]auto.organi[sz]['"` ]/i },
        { label: 'str:arrange',      re: /['"` ]arrange[_-]?battlefield['"` ]/i },
        // ActionCable action names
        { label: 'action:organiz',   re: /action\s*:\s*['"]organiz\w*/i },
        { label: 'action:arrange',   re: /action\s*:\s*['"]arrange\w*/i },
        // Emits
        { label: 'emit:organiz',     re: /\$?emit\s*\(\s*['"]organiz\w*/i },
        { label: 'emit:arrange',     re: /\$?emit\s*\(\s*['"]arrange\w*/i },
        // Context menu menu keys
        { label: 'menuKey:organiz',  re: /menuKeys?.*organiz/i },
        { label: 'menuKey:arrange',  re: /menuKeys?.*arrange/i },
        // Auto organise (British spelling used in the game UI)
        { label: 'str:auto_organise',re: /auto.organi[sz]e?\s+battlefield/i },
      ];

      for (const source of sources) {
        if (!source.content) continue;
        const lines = source.content.split('\n');
        const srcLabel = (source.url || source.id || 'inline').split('/').slice(-2).join('/');

        for (const { label, re } of patterns) {
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i])) continue;
            // Grab surrounding context (5 lines before + 10 after)
            const ctxStart = Math.max(0, i - 5);
            const ctxEnd   = Math.min(lines.length, i + 10);
            const context  = lines.slice(ctxStart, ctxEnd).join('\n');
            findings.push({
              label,
              source: srcLabel,
              url: source.url || null,
              line: i + 1,
              match: lines[i].trim().slice(0, 200),
              context: context.slice(0, 800),
            });
          }
        }
      }

      console.log(`[PG] Source analysis: ${findings.length} findings across ${sources.length} files`);
      logEv('ANALYZE', `${findings.length} findings`, { byLabel: groupBy(findings, 'label') });
      return findings;
    }

    function groupBy(arr, key) {
      return arr.reduce((acc, item) => {
        const k = item[key];
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {});
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXPORT DIAGNOSTIC BUNDLE
    // Full snapshot: sources, analysis, deep inspect, config, event log, DOM
    // ─────────────────────────────────────────────────────────────────────────
    async function exportDiagnosticBundle(statusCb) {
      statusCb('Running deep inspect...');
      const inspectReport = deepInspect();

      statusCb('Extracting JS sources...');
      const sources = await extractGameSources();

      statusCb('Analyzing sources...');
      const findings = analyzeSourcesForOrganize(sources);

      statusCb('Collecting DOM snapshot...');
      const domSnapshot = {
        url: location.href,
        title: document.title,
        scriptTags: [...document.querySelectorAll('script[src]')].map(s => s.src),
        relevantDom: collectRelevantDom(),
      };

      const bundle = {
        meta: {
          version: '4.0.0',
          timestamp: new Date().toISOString(),
          url: location.href,
          userAgent: navigator.userAgent,
        },
        config: CFG,
        eventLog: eventLog.slice(0, 200),
        deepInspect: inspectReport,
        sourceFindings: findings,
        dom: domSnapshot,
        sources, // full source content included
      };

      statusCb('Generating download...');
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `pg-diagnostic-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      statusCb(`Done — downloaded ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
      logEv('EXPORT', 'diagnostic bundle downloaded', { sizeKb: Math.round(blob.size / 1024), sourceCount: sources.length, findingCount: findings.length });
      setTimeout(() => statusCb(null), 5000);
    }

    function collectRelevantDom() {
      // Capture inner HTML of game-related elements (truncated)
      const selectors = [
        '#game-hud-layer', '#phaser-game', '.card-context-menu',
        '.hud-pass-wrap', '.game-hud-overlay', '[data-testid]',
      ];
      const result = {};
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) result[sel] = el.outerHTML.slice(0, 2000);
      }
      // Also capture all data-testid attributes
      result['_testids'] = [...document.querySelectorAll('[data-testid]')]
        .map(el => ({ testid: el.getAttribute('data-testid'), tag: el.tagName, text: (el.textContent || '').trim().slice(0, 60) }));
      return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PASS TURN HOOK
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
      const attachObs = () => {
        const target = document.body || document.documentElement;
        if (!target) { setTimeout(attachObs, 100); return; }
        const obs = new MutationObserver(tryHook);
        obs.observe(target, { childList: true, subtree: true });
      };
      attachObs();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXPLORER UI STYLES
    // ─────────────────────────────────────────────────────────────────────────
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
          position: fixed; top: 16px; right: 16px; width: 380px;
          max-height: 90vh; background: #111827; color: #d1d5db;
          border: 1px solid #374151; border-radius: 10px;
          font: 12px/1.4 monospace; z-index: 2147483647;
          display: flex; flex-direction: column;
          box-shadow: 0 8px 32px rgba(0,0,0,0.7); overflow: hidden;
        }
        #pg-panel-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 12px; background: #1f2937; border-bottom: 1px solid #374151;
          cursor: move; user-select: none; flex-shrink: 0;
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
        .pg-btn-orange { background: #92400e; color: #fde68a; }
        .pg-btn-purple { background: #4c1d95; color: #ddd6fe; }
        .pg-btn:disabled { opacity: 0.5; cursor: not-allowed; filter: none; }

        .pg-input {
          flex: 1; background: #0f172a; border: 1px solid #374151; border-radius: 4px;
          color: #34d399; padding: 3px 6px; font: 10px monospace; min-width: 0;
        }

        .pg-step {
          background: #0f172a; border: 1px solid #374151; border-radius: 6px;
          padding: 8px; display: flex; flex-direction: column; gap: 5px;
        }
        .pg-step.done   { border-color: #065f46; }
        .pg-step.active { border-color: #1d4ed8; }
        .pg-step-title  { font-weight: bold; font-size: 11px; }
        .pg-step.done .pg-step-title   { color: #34d399; }
        .pg-step.active .pg-step-title { color: #60a5fa; }
        .pg-step-desc   { color: #9ca3af; font-size: 10px; line-height: 1.4; }
        .pg-step-result {
          background: #0a1f0a; border: 1px solid #065f46; border-radius: 4px;
          padding: 4px 6px; color: #34d399; font-size: 10px; word-break: break-all;
        }
        .pg-status-msg  { color: #fbbf24; font-size: 10px; font-style: italic; }

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

        .pg-capture-banner {
          background: #7c2d12; color: #fed7aa; padding: 6px 10px;
          font-size: 11px; font-weight: bold; text-align: center;
          border-radius: 4px; animation: pg-pulse 1s infinite alternate;
        }
        @keyframes pg-pulse { from { opacity: 1; } to { opacity: 0.6; } }
      `;
      document.head.appendChild(s);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SETUP WIZARD STEPS
    // ─────────────────────────────────────────────────────────────────────────
    const stepStatus = {};

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
        id: 'hook-capture',
        title: '2. Hook Capture — learn the organize action',
        desc: 'Click Start, then right-click any card and click "Auto organise battlefield". The script will intercept the call and learn how to replay it automatically.',
        done: () => !!CFG.learnedOrganizeCall,
        result: () => CFG.learnedOrganizeCall ? JSON.stringify(CFG.learnedOrganizeCall).slice(0, 120) : null,
        run(setStatus) {
          setStatus('Capturing... right-click a card and click "Auto organise battlefield". (30s timeout, or click Stop in console: __pg_stopCapture())');
          rerenderWizard();
          startHookCapture((calls) => {
            if (calls.length === 0) {
              setStatus('No calls captured — make sure to click the organize button while capturing');
              setTimeout(() => { setStatus(null); rerenderWizard(); }, 6000);
              return;
            }
            logEv('HOOK-CAPTURE-RESULT', `${calls.length} calls recorded`, calls);
            console.log('[PG] Hook Capture results:', calls);
            // Auto-save the most likely organize call
            const organizeCall = calls.find(c => /organiz|arrange/i.test(c.label)) || calls[calls.length - 1];
            if (organizeCall) {
              // Map to a learnedOrganizeCall structure
              const learned = {
                type: organizeCall.label.startsWith('vue.') ? 'vue-method' :
                      organizeCall.label.startsWith('phaser.') ? 'direct-fn' : 'vue-method',
                path: organizeCall.label.replace(/^(vue\.\w+\.|phaser\.\w+\.)/, ''),
                fullLabel: organizeCall.label,
                args: organizeCall.args || [],
              };
              CFG.learnedOrganizeCall = learned;
              saveConfig();
              setStatus(`Learned: ${organizeCall.label} — testing now...`);
              setTimeout(() => {
                const ok = organizeBoard();
                setStatus(ok ? '✅ Organize works!' : '⚠️ Learned but replay failed — check console');
                setTimeout(() => { setStatus(null); rerenderWizard(); }, 5000);
              }, 500);
            } else {
              setStatus('Captured calls but none looked like organize — check event log');
              setTimeout(() => { setStatus(null); rerenderWizard(); }, 5000);
            }
          });
        },
      },
      {
        id: 'org-btn',
        title: '3. Capture "Organize Board" button selector (optional fallback)',
        desc: 'Open the right-click context menu, click Start, then click the organize button. Used as a fallback if Hook Capture fails.',
        done: () => CFG.organizeBtnSelector !== null,
        result: () => CFG.organizeBtnSelector || '(skipped)',
        run(setStatus) {
          setStatus('Click the organize button in the context menu... (Escape to skip)');
          const onEsc = (e) => {
            if (e.key !== 'Escape') return;
            document.removeEventListener('keydown', onEsc, true);
            if (captureClickActive) {
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
        id: 'test',
        title: '4. Test auto-organize',
        desc: 'Click to run the organizer now and see if cards rearrange.',
        done: () => false,
        result: () => null,
        run(setStatus) {
          const ok = organizeBoard();
          setStatus(ok ? '✅ Done — check your board!' : '❌ Failed — run Hook Capture first');
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
      const tag = el.tagName.toLowerCase();
      const cls = [...el.classList]
        .filter(c => !/^(top-|left-|right-|bottom-|translate|absolute|relative|w-|h-|rotate|scale)/.test(c))
        .slice(0, 2);
      return cls.length ? `${tag}.${cls.join('.')}` : sel;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER HELPERS
    // ─────────────────────────────────────────────────────────────────────────
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
            step.run((msg) => { stepStatus[step.id] = msg; rerenderWizard(); });
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
        { key: 'passTurnSelector',    label: 'Pass btn' },
        { key: 'organizeBtnSelector', label: 'Org btn' },
        { key: 'boardSelector',       label: 'Board' },
        { key: 'cardSelector',        label: 'Card' },
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
        <div class="pg-row" style="margin-top:4px">
          <span class="pg-label">Learned call</span>
          <span class="pg-val ${CFG.learnedOrganizeCall ? '' : 'empty'}" style="font-size:9px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${CFG.learnedOrganizeCall ? esc(JSON.stringify(CFG.learnedOrganizeCall).slice(0, 100)) : '(none — run Hook Capture)'}
          </span>
        </div>
        <div class="pg-row">
          <button class="pg-btn pg-btn-green" id="pg-save-cfg">Save</button>
          <button class="pg-btn pg-btn-red"   id="pg-reset-cfg">Reset All</button>
          <button class="pg-btn pg-btn-gray"  id="pg-copy-cfg">Copy JSON</button>
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
        rerenderWizard();
      };
      el.querySelector('#pg-reset-cfg').onclick = () => {
        if (confirm('Reset all discovered selectors and config?')) {
          localStorage.removeItem(STORAGE_KEY);
          location.reload();
        }
      };
      el.querySelector('#pg-copy-cfg').onclick = () => navigator.clipboard.writeText(JSON.stringify(CFG, null, 2));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // DEEP RUNTIME INSPECTOR
    // ─────────────────────────────────────────────────────────────────────────
    function scanWindow() {
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
        vue: null, phaser: null, stateManager: null,
        organizeMethods: [], passTurnMethods: [], allGameObjects: [],
      };

      // ── 1. Find Vue 3 app instance ────────────────────────────────────────
      try {
        const vueRoots = [...document.querySelectorAll('[data-v-app], #app, #game-app, [id*="app"], canvas')];
        for (const el of vueRoots) {
          if (!el.__vue_app__) continue;
          report.vue = { found: true, element: el.id || el.tagName };
          const vueApp = el.__vue_app__;
          win.__pg_vueApp = vueApp;
          const walkComponent = (vnode, depth = 0) => {
            if (!vnode || depth > 6) return;
            try {
              const component = vnode.component;
              if (component) {
                const proxy = component.proxy || component.ctx;
                if (proxy) {
                  const keys = Object.keys(proxy).concat(
                    Object.getOwnPropertyNames(Object.getPrototypeOf(proxy) || {})
                  );
                  keys.forEach(k => {
                    try {
                      const v = proxy[k];
                      if (typeof v === 'function') {
                        if (/organiz|arrange|sort.*card|card.*sort/i.test(k))
                          report.organizeMethods.push({ path: `vue.component.${k}`, fn: String(v).slice(0, 150) });
                        if (/passTurn|pass_turn|endTurn|end_turn|nextTurn|next_turn/i.test(k))
                          report.passTurnMethods.push({ path: `vue.component.${k}`, fn: String(v).slice(0, 150) });
                        if (/game|board|card|zone|battlefield|hand|library|state|manager|channel/i.test(k))
                          report.allGameObjects.push({ path: `vue.component.${k}`, type: typeof v });
                      } else if (v && typeof v === 'object') {
                        if (/game|board|state|manager|channel/i.test(k))
                          report.allGameObjects.push({ path: `vue.component.${k}`, type: 'object', keys: Object.keys(v).slice(0, 20) });
                      }
                    } catch (_) {}
                  });
                  win.__pg_vueComponent = proxy;
                }
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
      } catch (e) { report.vue = { error: String(e) }; }

      // ── 2. Find Phaser game instance ──────────────────────────────────────
      try {
        let phaserGame = win.__pg_phaserGame || win.Phaser?.game || win.__PHASER_GAME__ || win.game;
        if (!phaserGame?.scene) {
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
          for (const k of ['__PHASER_GAME__', '__game', '_game', 'phaserGame', 'GAME', 'g']) {
            if (win[k]?.scene) { phaserGame = win[k]; break; }
          }
        }
        if (phaserGame?.scene) {
          win.__pg_phaserGame = phaserGame;
          report.phaser = { found: true, sceneCount: phaserGame.scene.scenes?.length };
          const PHASER_INTERNALS = /^(sys|events|input|tweens|time|physics|cameras|add|make|scale|scene|anims|sound|data|plugins|registry|textures|renderer|cache|loader|children|displayList|updateList|game|lights|matter)$/;
          (phaserGame.scene.scenes || []).forEach((scene, i) => {
            const sceneName = scene.sys?.settings?.key || `scene_${i}`;
            const allKeys = [];
            let proto = scene;
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
                  if (/organiz|arrange|sort.*card|layout.*card|tidy/i.test(k))
                    report.organizeMethods.push({ path: `phaser.${sceneName}.${k}`, fn: String(v).slice(0, 200) });
                  if (/card|board|zone|hand|battlefield|permanent|state|manager|channel/i.test(k))
                    report.allGameObjects.push({ path: `phaser.${sceneName}.${k}`, type: 'function' });
                } else if (v && typeof v === 'object') {
                  if (/card|board|zone|hand|state|manager|channel|permanent/i.test(k)) {
                    report.allGameObjects.push({ path: `phaser.${sceneName}.${k}`, type: 'object', subKeys: Object.keys(v).slice(0, 30) });
                    win[`__pg_scene_${sceneName}_${k}`] = v;
                  }
                }
              } catch (_) {}
            }
            win[`__pg_scene_${sceneName}`] = scene;
          });
        } else {
          report.phaser = { found: false };
        }
      } catch (e) { report.phaser = { error: String(e) }; }

      // ── 3. StateManager hunt ──────────────────────────────────────────────
      try {
        const huntObj = (obj, path, depth = 0, visited = new WeakSet()) => {
          if (depth > 4 || !obj || typeof obj !== 'object') return;
          if (visited.has(obj)) return;
          visited.add(obj);
          try {
            for (const k of Object.keys(obj)) {
              try {
                const v = obj[k];
                const p = `${path}.${k}`;
                if (v && typeof v === 'object') {
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
      } catch (_) {}

      console.log('[PG] Deep inspect report:', report);
      logEv('DEEP-INSPECT',
        `Vue:${!!report.vue?.found} Phaser:${!!report.phaser?.found} SM:${!!report.stateManager} Organize:${report.organizeMethods.length} PassTurn:${report.passTurnMethods.length} GameObjs:${report.allGameObjects.length}`,
        report
      );
      refreshLogPanel();
      return report;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PANEL CONSTRUCTION
    // ─────────────────────────────────────────────────────────────────────────
    let panelEl = null;

    function openPanel() {
      if (panelEl) { panelEl.style.display = 'flex'; explorerOpen = true; startWatchers(); refreshLogPanel(); return; }
      buildStyles();
      panelEl = document.createElement('div');
      panelEl.id = 'pg-panel';
      panelEl.innerHTML = `
        <div id="pg-panel-header">
          <div>
            <div class="title">PG Explorer v4</div>
            <div class="hint">F2 to toggle</div>
          </div>
          <div id="pg-panel-header-btns">
            <button id="pg-min-btn">_</button>
            <button id="pg-close-btn">x</button>
          </div>
        </div>
        <div id="pg-panel-body"></div>
      `;
      document.body.appendChild(panelEl);
      makeDraggable(panelEl, panelEl.querySelector('#pg-panel-header'));

      const body = panelEl.querySelector('#pg-panel-body');

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

      // ── Wizard section ────────────────────────────────────────────────────
      body.appendChild(section('Setup Wizard', 'pg-wizard-section', '<div id="pg-wizard-steps"></div>', true));

      // ── Actions section ───────────────────────────────────────────────────
      body.appendChild(section('Actions', 'pg-actions-section', `
        <div class="pg-row">
          <button class="pg-btn pg-btn-green"  id="pg-run-org">▶ Organize Now</button>
          <button class="pg-btn pg-btn-orange" id="pg-hook-capture-btn">🎣 Hook Capture</button>
        </div>
        <div id="pg-hook-capture-status" style="display:none" class="pg-capture-banner">
          Capturing — right-click a card then click "Auto organise battlefield"
          <br><button class="pg-btn pg-btn-red" id="pg-stop-capture-btn" style="margin-top:4px">Stop Capture</button>
        </div>
        <div class="pg-row" style="margin-top:4px">
          <button class="pg-btn pg-btn-blue"   id="pg-deep-inspect">Deep Inspect</button>
          <button class="pg-btn pg-btn-blue"   id="pg-scan-win">Shallow Scan</button>
          <button class="pg-btn pg-btn-gray"   id="pg-hook-ctx">Hook Context Menu</button>
        </div>
        <div class="pg-row" style="margin-top:4px">
          <button class="pg-btn pg-btn-purple" id="pg-export-diag">Download Diagnostic Bundle</button>
        </div>
        <div id="pg-diag-status" style="color:#fbbf24;font-size:10px;margin-top:4px;display:none"></div>
        <div class="pg-row" style="margin-top:4px">
          <button class="pg-btn pg-btn-gray"   id="pg-export-log">Export Event Log</button>
        </div>
        <div style="color:#6b7280;font-size:10px;margin-top:4px">
          After Deep Inspect: window.__pg_vueComponent, __pg_stateManager, __pg_scene_* in console
        </div>
      `, true));

      // ── Log section ───────────────────────────────────────────────────────
      body.appendChild(section('Event Log', 'pg-log-section', `
        <div id="pg-log"></div>
        <div class="pg-row" style="margin-top:4px">
          <button class="pg-btn pg-btn-red" id="pg-clear-log">Clear</button>
          <span id="pg-log-count" style="color:#6b7280;font-size:10px"></span>
        </div>
      `, true));

      // ── Config section ────────────────────────────────────────────────────
      body.appendChild(section('Config', 'pg-config-section', '<div id="pg-config-fields"></div>', false));

      // ── Wire up actions ───────────────────────────────────────────────────
      panelEl.querySelector('#pg-close-btn').onclick = closePanel;
      panelEl.querySelector('#pg-min-btn').onclick = () => {
        const b = panelEl.querySelector('#pg-panel-body');
        b.style.display = b.style.display === 'none' ? '' : 'none';
      };

      panelEl.querySelector('#pg-run-org').onclick = () => organizeBoard();
      panelEl.querySelector('#pg-deep-inspect').onclick = () => deepInspect();
      panelEl.querySelector('#pg-scan-win').onclick = () => scanWindow();
      panelEl.querySelector('#pg-hook-ctx').onclick = () => hookCardContextMenu();

      panelEl.querySelector('#pg-export-log').onclick = () => {
        const blob = new Blob([JSON.stringify(eventLog, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `pg-event-log-${Date.now()}.json`;
        a.click();
      };

      panelEl.querySelector('#pg-clear-log').onclick = () => { eventLog.length = 0; refreshLogPanel(); };

      // Hook Capture button
      panelEl.querySelector('#pg-hook-capture-btn').onclick = () => {
        const statusEl = panelEl.querySelector('#pg-hook-capture-status');
        statusEl.style.display = 'block';
        panelEl.querySelector('#pg-hook-capture-btn').disabled = true;
        startHookCapture((calls) => {
          statusEl.style.display = 'none';
          panelEl.querySelector('#pg-hook-capture-btn').disabled = false;
          if (calls.length === 0) {
            logEv('HOOK-CAPTURE-RESULT', 'no calls captured', {});
            return;
          }
          logEv('HOOK-CAPTURE-RESULT', `${calls.length} calls captured`, calls);
          console.log('[PG] Hook Capture results:', calls);
          // Find most likely organize call and save it
          const organizeCall = calls.find(c => /organiz|arrange/i.test(c.label)) || calls[calls.length - 1];
          if (organizeCall) {
            const learned = {
              type: organizeCall.label.startsWith('phaser.') ? 'direct-fn' : 'vue-method',
              path: organizeCall.label.replace(/^(vue\.\w+\.|phaser\.\w+\.)/, ''),
              fullLabel: organizeCall.label,
              args: organizeCall.args || [],
            };
            CFG.learnedOrganizeCall = learned;
            saveConfig();
            rerenderWizard();
            refreshConfigPanel();
          }
        });
      };

      panelEl.querySelector('#pg-stop-capture-btn').onclick = () => {
        if (win.__pg_stopCapture) win.__pg_stopCapture();
      };

      // Diagnostic bundle button
      panelEl.querySelector('#pg-export-diag').onclick = async () => {
        const btn = panelEl.querySelector('#pg-export-diag');
        const statusEl = panelEl.querySelector('#pg-diag-status');
        btn.disabled = true;
        statusEl.style.display = 'block';
        try {
          await exportDiagnosticBundle((msg) => {
            statusEl.textContent = msg || '';
            if (!msg) { statusEl.style.display = 'none'; btn.disabled = false; }
          });
        } catch (e) {
          statusEl.textContent = `Error: ${e.message}`;
          btn.disabled = false;
          setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
        }
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
    // F2 TOGGLES EXPLORER
    // ─────────────────────────────────────────────────────────────────────────
    win.addEventListener('keydown', (e) => {
      if (e.code === 'F2') {
        e.preventDefault();
        e.stopImmediatePropagation();
        explorerOpen ? closePanel() : openPanel();
      }
    }, true);

    // ─────────────────────────────────────────────────────────────────────────
    // BOOT
    // ─────────────────────────────────────────────────────────────────────────
    hookPassTurn();

    console.log('[PG] Ready. Press F2 to open the explorer panel.');
    console.log('[PG] Current config:', CFG);
  }

})();
