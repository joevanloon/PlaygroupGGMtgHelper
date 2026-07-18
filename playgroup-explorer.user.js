// ==UserScript==
// @name         Playgroup.gg Explorer & Auto-Organizer
// @namespace    https://playgroup.gg/
// @version      1.0.0
// @description  Interactive diagnostic tool + auto board organizer for playgroup.gg
// @author       You
// @match        https://playgroup.gg/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // CONFIG — updated automatically by the wizard, or hand-edit after discovery
  // ─────────────────────────────────────────────────────────────────────────────
  const CONFIG = {
    // Selectors discovered via the wizard — left empty until wizard runs
    passTurnSelector: null,       // e.g. 'button[data-action*="passTurn"]'
    passTurnKey: null,            // e.g. 'KeyN' or null if click-only
    organizeBtnSelector: null,    // existing organize button, if any
    boardSelector: null,          // main board/battlefield container
    cardSelector: null,           // individual card elements on board
    handSelector: null,           // hand zone container

    // Auto-organize behavior
    autoOrganizeOnPassTurn: true,
    organizeDelay: 300,           // ms after pass-turn before organizing

    // Debug
    verbose: true,
  };

  // Persist discovered config across reloads
  const STORAGE_KEY = 'pg_explorer_config';
  function loadConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      Object.assign(CONFIG, saved);
    } catch (_) {}
  }
  function saveConfig() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(CONFIG));
  }
  loadConfig();

  // ─────────────────────────────────────────────────────────────────────────────
  // LOGGING
  // ─────────────────────────────────────────────────────────────────────────────
  const LOG_PREFIX = '[PG-Explorer]';
  const log = (...a) => CONFIG.verbose && console.log(LOG_PREFIX, ...a);
  const logEvent = (label, data) => CONFIG.verbose && console.log(`${LOG_PREFIX} 🔍 ${label}`, data);

  // ─────────────────────────────────────────────────────────────────────────────
  // STYLES
  // ─────────────────────────────────────────────────────────────────────────────
  const STYLE = document.createElement('style');
  STYLE.textContent = `
    #pg-explorer-root {
      position: fixed;
      top: 16px;
      right: 16px;
      width: 340px;
      max-height: 90vh;
      background: #1a1a2e;
      color: #e0e0e0;
      border: 1px solid #444;
      border-radius: 10px;
      font-family: monospace;
      font-size: 12px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
      overflow: hidden;
      transition: height 0.2s;
    }
    #pg-explorer-root.minimized { height: 36px; }
    #pg-explorer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      background: #16213e;
      border-bottom: 1px solid #333;
      cursor: move;
      user-select: none;
    }
    #pg-explorer-header span { font-weight: bold; color: #7ec8e3; font-size: 13px; }
    #pg-explorer-header-btns { display: flex; gap: 4px; }
    #pg-explorer-header-btns button {
      background: none; border: 1px solid #444; border-radius: 4px;
      color: #aaa; cursor: pointer; padding: 1px 6px; font-size: 11px;
    }
    #pg-explorer-header-btns button:hover { background: #333; color: #fff; }
    #pg-explorer-body { overflow-y: auto; display: flex; flex-direction: column; gap: 0; }

    .pg-section {
      border-bottom: 1px solid #2a2a4a;
    }
    .pg-section-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 6px 10px;
      background: #0f3460;
      cursor: pointer;
      font-weight: bold; color: #7ec8e3; font-size: 11px;
      user-select: none;
    }
    .pg-section-header:hover { background: #1a4a7a; }
    .pg-section-body { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
    .pg-section-body.collapsed { display: none; }

    .pg-btn {
      padding: 5px 10px; border-radius: 5px; border: none; cursor: pointer;
      font-size: 11px; font-family: monospace; font-weight: bold;
      transition: background 0.15s;
    }
    .pg-btn-primary { background: #0f3460; color: #7ec8e3; border: 1px solid #7ec8e3; }
    .pg-btn-primary:hover { background: #1a5090; }
    .pg-btn-success { background: #1a4a2a; color: #7ed88a; border: 1px solid #7ed88a; }
    .pg-btn-success:hover { background: #226030; }
    .pg-btn-danger { background: #4a1a1a; color: #e07070; border: 1px solid #e07070; }
    .pg-btn-danger:hover { background: #602020; }
    .pg-btn-warn { background: #3a2a00; color: #f0c040; border: 1px solid #f0c040; }
    .pg-btn-warn:hover { background: #503800; }
    .pg-btn-row { display: flex; gap: 6px; flex-wrap: wrap; }

    .pg-wizard-step {
      background: #0a0a1e;
      border: 1px solid #333;
      border-radius: 6px;
      padding: 8px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .pg-wizard-step .step-label {
      color: #f0c040; font-weight: bold; font-size: 11px;
    }
    .pg-wizard-step .step-desc { color: #ccc; line-height: 1.4; }
    .pg-wizard-step.done { border-color: #7ed88a; }
    .pg-wizard-step.done .step-label { color: #7ed88a; }
    .pg-wizard-step.active { border-color: #7ec8e3; }

    .pg-result {
      background: #0a1a0a; border: 1px solid #2a4a2a;
      border-radius: 4px; padding: 5px 7px; word-break: break-all;
      color: #7ed88a; font-size: 10px; max-height: 80px; overflow-y: auto;
    }
    .pg-result.empty { color: #666; font-style: italic; }
    .pg-result.error { background: #1a0a0a; border-color: #4a2a2a; color: #e07070; }

    #pg-event-log {
      background: #0a0a0a; border: 1px solid #222;
      border-radius: 4px; padding: 5px; max-height: 160px; overflow-y: auto;
      font-size: 10px;
    }
    .pg-event-entry { padding: 2px 0; border-bottom: 1px solid #1a1a1a; }
    .pg-event-entry .ev-time { color: #555; }
    .pg-event-entry .ev-type { color: #7ec8e3; font-weight: bold; }
    .pg-event-entry .ev-src  { color: #f0c040; }
    .pg-event-entry .ev-data { color: #aaa; word-break: break-all; }

    .pg-config-row { display: flex; gap: 6px; align-items: center; }
    .pg-config-row label { color: #aaa; flex: 0 0 80px; }
    .pg-config-row input[type=text] {
      flex: 1; background: #0a0a1e; border: 1px solid #333; border-radius: 4px;
      color: #7ec8e3; padding: 3px 5px; font-family: monospace; font-size: 10px;
    }
    .pg-config-row input[type=checkbox] { width: 14px; height: 14px; accent-color: #7ec8e3; }
    .pg-config-row span.pg-cfg-val { color: #7ec8e3; font-size: 10px; }

    .pg-highlight-ring {
      outline: 3px solid #ff4500 !important;
      outline-offset: 2px !important;
    }
    .pg-status { font-size: 10px; color: #888; font-style: italic; }
  `;
  document.head.appendChild(STYLE);

  // ─────────────────────────────────────────────────────────────────────────────
  // EVENT LOG — capture everything relevant
  // ─────────────────────────────────────────────────────────────────────────────
  const eventLog = [];
  const MAX_LOG = 200;

  function addLogEntry(type, src, data) {
    const entry = { time: Date.now(), type, src, data };
    eventLog.unshift(entry);
    if (eventLog.length > MAX_LOG) eventLog.pop();
    renderEventLog();
    logEvent(type, { src, data });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // GLOBAL EVENT WATCHERS
  // ─────────────────────────────────────────────────────────────────────────────
  let globalWatching = false;
  let captureClickActive = false;
  let captureKeyActive = false;
  let clickHandler = null;
  let keyHandler = null;
  const wsMessages = [];

  function startGlobalWatchers() {
    if (globalWatching) return;
    globalWatching = true;

    // Intercept fetch / XHR for turn-related network calls
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const url = args[0]?.url || args[0] || '';
      const method = args[1]?.method || 'GET';
      if (/turn|pass|phase|step|organiz|arrange/i.test(url)) {
        addLogEntry('FETCH', url, { method, body: args[1]?.body });
      }
      return origFetch.apply(this, args);
    };

    // Intercept WebSocket messages
    const OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      const ws = new OrigWS(url, protocols);
      ws.addEventListener('message', (ev) => {
        try {
          const parsed = JSON.parse(ev.data);
          const str = JSON.stringify(parsed);
          if (/turn|pass|phase|organiz|arrange|step/i.test(str)) {
            addLogEntry('WS-MSG', url, parsed);
            wsMessages.unshift({ time: Date.now(), data: parsed });
          }
        } catch (_) {}
      });
      addLogEntry('WS-OPEN', url, {});
      return ws;
    };
    Object.assign(window.WebSocket, OrigWS);

    // DOM mutation observer — track elements added/removed that look relevant
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const text = (node.textContent || '').toLowerCase();
          const cls = node.className || '';
          if (/pass|turn|organiz|arrange|end.*turn/i.test(text + cls)) {
            addLogEntry('DOM-ADD', selectorFor(node), {
              tag: node.tagName,
              class: cls,
              text: node.textContent?.slice(0, 60),
            });
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    // Monitor CustomEvents / Stimulus dispatches
    const origDispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (event) {
      if (event.type && !/^(mouse|pointer|touch|scroll|resize|focus|blur|input|change|transitionend|animationend)/.test(event.type)) {
        addLogEntry('CUSTOM-EVENT', selectorFor(this), {
          type: event.type,
          detail: event.detail,
        });
      }
      return origDispatch.call(this, event);
    };

    log('Global watchers active');
  }

  function stopGlobalWatchers() {
    globalWatching = false;
    log('Global watchers stopped (page reload needed to fully clear fetch/WS/event patches)');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CAPTURE MODE — user clicks an element to identify it
  // ─────────────────────────────────────────────────────────────────────────────
  let highlightedEl = null;

  function startClickCapture(onCapture) {
    captureClickActive = true;
    document.body.style.cursor = 'crosshair';

    const hover = (e) => {
      if (highlightedEl) highlightedEl.classList.remove('pg-highlight-ring');
      highlightedEl = e.target;
      highlightedEl.classList.add('pg-highlight-ring');
    };

    clickHandler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (highlightedEl) highlightedEl.classList.remove('pg-highlight-ring');
      document.body.style.cursor = '';
      document.removeEventListener('mouseover', hover, true);
      document.removeEventListener('click', clickHandler, true);
      captureClickActive = false;
      const el = e.target;
      const selector = selectorFor(el);
      onCapture(el, selector);
    };

    document.addEventListener('mouseover', hover, true);
    document.addEventListener('click', clickHandler, true);
  }

  function startKeyCapture(onCapture) {
    captureKeyActive = true;
    keyHandler = (e) => {
      document.removeEventListener('keydown', keyHandler, true);
      captureKeyActive = false;
      onCapture(e);
    };
    document.addEventListener('keydown', keyHandler, true);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SELECTOR BUILDER — produces a reasonable CSS selector for any element
  // ─────────────────────────────────────────────────────────────────────────────
  function selectorFor(el) {
    if (!el || el === document || el === window) return '(none)';
    if (el.id) return `#${el.id}`;

    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 5) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { part = `#${cur.id}`; parts.unshift(part); break; }
      const dataAction = cur.getAttribute('data-action');
      const dataController = cur.getAttribute('data-controller');
      const dataTurbo = cur.getAttribute('data-turbo-frame');
      if (dataAction) part += `[data-action*="${dataAction.split('->')[0].trim()}"]`;
      else if (dataController) part += `[data-controller="${dataController}"]`;
      else if (dataTurbo) part += `[data-turbo-frame="${dataTurbo}"]`;
      else {
        const classes = [...cur.classList]
          .filter(c => !/^(text-|bg-|p-|m-|w-|h-|flex|grid|block|hidden|rounded|border|shadow|cursor|hover:|focus:|transition)/.test(c))
          .slice(0, 3);
        if (classes.length) part += '.' + classes.join('.');
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // BOARD ORGANIZER — prototype logic (runs once selectors are known)
  // ─────────────────────────────────────────────────────────────────────────────
  function organizeBoard() {
    const boardSel = CONFIG.boardSelector;
    const cardSel = CONFIG.cardSelector;
    if (!boardSel || !cardSel) {
      log('organizeBoard: selectors not configured yet');
      return false;
    }

    const board = document.querySelector(boardSel);
    if (!board) { log('organizeBoard: board element not found'); return false; }

    const cards = [...board.querySelectorAll(cardSel)];
    if (!cards.length) { log('organizeBoard: no cards found'); return false; }

    log(`organizeBoard: arranging ${cards.length} cards`);

    const boardRect = board.getBoundingClientRect();
    const cols = Math.ceil(Math.sqrt(cards.length));
    const cardW = (boardRect.width / cols) - 8;
    const cardH = cardW * 1.4; // MTG card ratio ~1:1.4

    cards.forEach((card, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * (cardW + 8) + 4;
      const y = row * (cardH + 8) + 4;
      card.style.position = 'absolute';
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      card.style.transition = 'left 0.25s ease, top 0.25s ease';
    });

    addLogEntry('ORGANIZE', boardSel, { cardCount: cards.length, cols });
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PASS TURN HOOK — wire up once selector is known
  // ─────────────────────────────────────────────────────────────────────────────
  let passTurnHookActive = false;

  function hookPassTurn() {
    if (passTurnHookActive) return;

    const tryHook = () => {
      const sel = CONFIG.passTurnSelector;
      if (!sel) return;

      const btn = document.querySelector(sel);
      if (!btn) return;

      btn.addEventListener('click', () => {
        addLogEntry('PASS-TURN', sel, { trigger: 'click' });
        if (CONFIG.autoOrganizeOnPassTurn) {
          setTimeout(() => organizeBoard(), CONFIG.organizeDelay);
        }
      }, true);

      passTurnHookActive = true;
      log(`Pass-turn hook active on: ${sel}`);
    };

    tryHook();
    // Keep trying in case button appears later (Turbo navigation)
    const observer = new MutationObserver(tryHook);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function hookPassTurnKey() {
    const key = CONFIG.passTurnKey;
    if (!key) return;
    document.addEventListener('keydown', (e) => {
      if (e.code === key && !e.target.matches('input, textarea')) {
        addLogEntry('PASS-TURN', 'keyboard', { key: e.code, trigger: 'keydown' });
        if (CONFIG.autoOrganizeOnPassTurn) {
          setTimeout(() => organizeBoard(), CONFIG.organizeDelay);
        }
      }
    }, true);
    log(`Pass-turn key hook active: ${key}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WIZARD STEPS
  // ─────────────────────────────────────────────────────────────────────────────
  const WIZARD_STEPS = [
    {
      id: 'pass-turn-btn',
      label: '1. Capture "Pass Turn" Button',
      desc: 'Click the button below, then click the Pass Turn button in the game.',
      done: () => !!CONFIG.passTurnSelector,
      result: () => CONFIG.passTurnSelector,
      action: (updateStep) => {
        updateStep('Waiting — click the Pass Turn button in the game…');
        startClickCapture((el, sel) => {
          CONFIG.passTurnSelector = sel;
          saveConfig();
          hookPassTurn();
          updateStep(null);
          renderWizard();
          addLogEntry('WIZARD', 'pass-turn-btn', { selector: sel, element: el.outerHTML.slice(0, 120) });
        });
      },
    },
    {
      id: 'pass-turn-key',
      label: '2. Capture "Pass Turn" Keyboard Shortcut (optional)',
      desc: 'Click the button below, then press the keyboard shortcut for passing turn (if one exists). Press Escape to skip.',
      done: () => CONFIG.passTurnKey !== null,
      result: () => CONFIG.passTurnKey || '(none — skipped)',
      action: (updateStep) => {
        updateStep('Waiting — press the pass-turn key (or Esc to skip)…');
        startKeyCapture((e) => {
          if (e.key === 'Escape') {
            CONFIG.passTurnKey = false; // explicit skip
          } else {
            CONFIG.passTurnKey = e.code;
            hookPassTurnKey();
          }
          saveConfig();
          updateStep(null);
          renderWizard();
          addLogEntry('WIZARD', 'pass-turn-key', { code: e.code, key: e.key });
        });
      },
    },
    {
      id: 'organize-btn',
      label: '3. Capture "Organize Board" Button (if exists)',
      desc: 'If playgroup.gg has an existing organize/arrange button, click below then click it. Press Escape to skip.',
      done: () => CONFIG.organizeBtnSelector !== null,
      result: () => CONFIG.organizeBtnSelector || '(none — skipped)',
      action: (updateStep) => {
        updateStep('Waiting — click the Organize button (or Esc to skip)…');

        const escListener = (e) => {
          if (e.key === 'Escape') {
            document.removeEventListener('keydown', escListener, true);
            if (captureClickActive && clickHandler) {
              document.removeEventListener('click', clickHandler, true);
              document.body.style.cursor = '';
              captureClickActive = false;
            }
            if (highlightedEl) highlightedEl.classList.remove('pg-highlight-ring');
            CONFIG.organizeBtnSelector = false;
            saveConfig();
            updateStep(null);
            renderWizard();
          }
        };
        document.addEventListener('keydown', escListener, true);

        startClickCapture((el, sel) => {
          document.removeEventListener('keydown', escListener, true);
          CONFIG.organizeBtnSelector = sel;
          saveConfig();
          updateStep(null);
          renderWizard();
          addLogEntry('WIZARD', 'organize-btn', { selector: sel });
        });
      },
    },
    {
      id: 'board-container',
      label: '4. Capture Board Container Element',
      desc: 'Click the button below, then click anywhere on the main battlefield/board area.',
      done: () => !!CONFIG.boardSelector,
      result: () => CONFIG.boardSelector,
      action: (updateStep) => {
        updateStep('Waiting — click anywhere on the battlefield/board area…');
        startClickCapture((el, sel) => {
          CONFIG.boardSelector = sel;
          saveConfig();
          updateStep(null);
          renderWizard();
          addLogEntry('WIZARD', 'board-container', { selector: sel });
        });
      },
    },
    {
      id: 'card-element',
      label: '5. Capture a Card Element',
      desc: 'Click the button below, then click any card on the battlefield.',
      done: () => !!CONFIG.cardSelector,
      result: () => CONFIG.cardSelector,
      action: (updateStep) => {
        updateStep('Waiting — click any card on the battlefield…');
        startClickCapture((el, sel) => {
          // Generalise the selector — strip positional specifics
          const generalSel = generalizeCardSelector(el, sel);
          CONFIG.cardSelector = generalSel;
          saveConfig();
          updateStep(null);
          renderWizard();
          addLogEntry('WIZARD', 'card-element', { specific: sel, general: generalSel });
        });
      },
    },
    {
      id: 'test-organize',
      label: '6. Test Board Organization',
      desc: 'Click the button below to run the auto-organize now and see if it works.',
      done: () => false, // always re-runnable
      result: () => null,
      action: (updateStep) => {
        const ok = organizeBoard();
        updateStep(ok ? '✅ Organization applied! Check your board.' : '❌ Failed — check selectors above.');
        setTimeout(() => updateStep(null), 4000);
      },
    },
  ];

  function generalizeCardSelector(el, specificSel) {
    // Try to find a data attribute that identifies cards
    const dataAttrs = ['data-card-id', 'data-card', 'data-permanent-id', 'data-permanent', 'data-object-id'];
    for (const attr of dataAttrs) {
      if (el.hasAttribute(attr) || el.closest(`[${attr}]`)) {
        return `[${attr}]`;
      }
    }
    // Fall back to class-based, stripping specific positional classes
    const tagName = el.tagName.toLowerCase();
    const classes = [...el.classList]
      .filter(c => !/^(top-|left-|right-|bottom-|translate|absolute|relative)/.test(c))
      .slice(0, 2);
    return classes.length ? `${tagName}.${classes.join('.')}` : specificSel;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UI RENDERING
  // ─────────────────────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.id = 'pg-explorer-root';
  document.body.appendChild(root);

  let minimized = false;
  const stepStatusMap = {}; // stepId -> status message while waiting

  function renderWizard() {
    const container = document.getElementById('pg-wizard-container');
    if (!container) return;
    container.innerHTML = '';
    WIZARD_STEPS.forEach((step) => {
      const isDone = step.done();
      const result = step.result ? step.result() : null;
      const statusMsg = stepStatusMap[step.id];

      const div = document.createElement('div');
      div.className = `pg-wizard-step ${isDone ? 'done' : ''} ${statusMsg ? 'active' : ''}`;
      div.innerHTML = `
        <div class="step-label">${isDone ? '✅' : '⭕'} ${step.label}</div>
        <div class="step-desc">${step.desc}</div>
        ${result ? `<div class="pg-result">${escHtml(result)}</div>` : ''}
        ${statusMsg ? `<div class="pg-status">${escHtml(statusMsg)}</div>` : ''}
      `;

      if (!statusMsg) {
        const btn = document.createElement('button');
        btn.className = `pg-btn ${isDone ? 'pg-btn-success' : 'pg-btn-primary'}`;
        btn.textContent = isDone ? '↺ Re-capture' : '▶ Start';
        btn.onclick = () => {
          step.action((msg) => {
            stepStatusMap[step.id] = msg;
            renderWizard();
          });
          stepStatusMap[step.id] = 'Initialising…';
          renderWizard();
        };
        div.appendChild(btn);
      }

      container.appendChild(div);
    });
  }

  function renderEventLog() {
    const el = document.getElementById('pg-event-log');
    if (!el) return;
    el.innerHTML = eventLog.slice(0, 50).map(e => `
      <div class="pg-event-entry">
        <span class="ev-time">${new Date(e.time).toLocaleTimeString()}</span>
        <span class="ev-type"> [${escHtml(e.type)}]</span>
        <span class="ev-src"> ${escHtml(String(e.src).slice(0, 60))}</span>
        <span class="ev-data"> — ${escHtml(JSON.stringify(e.data).slice(0, 80))}</span>
      </div>
    `).join('') || '<div class="pg-status">No events captured yet.</div>';
  }

  function renderConfigPanel() {
    const el = document.getElementById('pg-config-panel');
    if (!el) return;
    const fields = [
      { key: 'passTurnSelector', label: 'Pass Btn' },
      { key: 'passTurnKey', label: 'Pass Key' },
      { key: 'organizeBtnSelector', label: 'Org Btn' },
      { key: 'boardSelector', label: 'Board' },
      { key: 'cardSelector', label: 'Card' },
    ];
    el.innerHTML = fields.map(f => `
      <div class="pg-config-row">
        <label>${escHtml(f.label)}</label>
        <input type="text" data-cfg="${f.key}" value="${escHtml(String(CONFIG[f.key] || ''))}" placeholder="(not set)" />
      </div>
    `).join('') + `
      <div class="pg-config-row">
        <label>Auto-org</label>
        <input type="checkbox" data-cfg-bool="autoOrganizeOnPassTurn" ${CONFIG.autoOrganizeOnPassTurn ? 'checked' : ''} />
        <span class="pg-cfg-val">on pass turn</span>
      </div>
      <div class="pg-btn-row">
        <button class="pg-btn pg-btn-success" id="pg-save-config">💾 Save Config</button>
        <button class="pg-btn pg-btn-danger" id="pg-reset-config">🗑 Reset All</button>
      </div>
    `;

    el.querySelector('#pg-save-config').onclick = () => {
      el.querySelectorAll('[data-cfg]').forEach(input => {
        const val = input.value.trim();
        CONFIG[input.dataset.cfg] = val || null;
      });
      el.querySelectorAll('[data-cfg-bool]').forEach(input => {
        CONFIG[input.dataset.cfgBool] = input.checked;
      });
      saveConfig();
      hookPassTurn();
      hookPassTurnKey();
      addLogEntry('CONFIG', 'manual-save', CONFIG);
      renderWizard();
    };

    el.querySelector('#pg-reset-config').onclick = () => {
      if (confirm('Reset all discovered selectors?')) {
        localStorage.removeItem(STORAGE_KEY);
        location.reload();
      }
    };
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function makeSection(id, title, bodyHtml, startOpen = true) {
    const section = document.createElement('div');
    section.className = 'pg-section';
    section.innerHTML = `
      <div class="pg-section-header" data-section="${id}">
        <span>${title}</span><span>▾</span>
      </div>
      <div class="pg-section-body ${startOpen ? '' : 'collapsed'}" id="pg-section-body-${id}">
        ${bodyHtml}
      </div>
    `;
    section.querySelector('.pg-section-header').onclick = () => {
      const body = section.querySelector('.pg-section-body');
      body.classList.toggle('collapsed');
    };
    return section;
  }

  function render() {
    root.innerHTML = `
      <div id="pg-explorer-header">
        <span>🔬 PG Explorer</span>
        <div id="pg-explorer-header-btns">
          <button id="pg-minimize-btn">_</button>
          <button id="pg-close-btn">✕</button>
        </div>
      </div>
      <div id="pg-explorer-body"></div>
    `;

    const body = root.querySelector('#pg-explorer-body');

    // ── Section: Wizard
    const wizardSection = makeSection('wizard', '🧙 Setup Wizard', `
      <div id="pg-wizard-container"></div>
    `, true);
    body.appendChild(wizardSection);

    // ── Section: Actions
    const actionsSection = makeSection('actions', '⚡ Actions', `
      <div class="pg-btn-row">
        <button class="pg-btn pg-btn-success" id="pg-organize-now">▶ Organize Now</button>
        <button class="pg-btn pg-btn-warn" id="pg-start-watching">👁 Start Watching</button>
        <button class="pg-btn pg-btn-danger" id="pg-stop-watching">⛔ Stop Watching</button>
      </div>
      <div class="pg-btn-row">
        <button class="pg-btn pg-btn-primary" id="pg-dump-window">🔍 Dump window.*</button>
        <button class="pg-btn pg-btn-primary" id="pg-find-functions">🔍 Find game fns</button>
      </div>
    `, true);
    body.appendChild(actionsSection);

    // ── Section: Event Log
    const logSection = makeSection('log', '📋 Event Log', `
      <div id="pg-event-log"></div>
      <div class="pg-btn-row" style="margin-top:4px">
        <button class="pg-btn pg-btn-danger" id="pg-clear-log" style="font-size:10px">Clear Log</button>
      </div>
    `, true);
    body.appendChild(logSection);

    // ── Section: Config
    const configSection = makeSection('config', '⚙️ Config', `
      <div id="pg-config-panel"></div>
    `, false);
    body.appendChild(configSection);

    // ── Wire up actions
    root.querySelector('#pg-minimize-btn').onclick = () => {
      minimized = !minimized;
      root.classList.toggle('minimized', minimized);
      body.style.display = minimized ? 'none' : '';
    };
    root.querySelector('#pg-close-btn').onclick = () => root.remove();

    root.querySelector('#pg-organize-now').onclick = () => organizeBoard();
    root.querySelector('#pg-start-watching').onclick = () => startGlobalWatchers();
    root.querySelector('#pg-stop-watching').onclick = () => stopGlobalWatchers();
    root.querySelector('#pg-clear-log').onclick = () => { eventLog.length = 0; renderEventLog(); };

    root.querySelector('#pg-dump-window').onclick = () => {
      const keys = Object.keys(window).filter(k => !['onmessage','location','history','navigator','document','window','self','top','parent','frames','length','name','closed','status'].includes(k));
      const gameKeys = keys.filter(k => /game|board|card|play|turn|organiz|arrange|match|hand|zone|permanent|battlefield/i.test(k));
      addLogEntry('WINDOW-DUMP', 'window.*', { allKeys: keys.length, gameRelated: gameKeys });
      console.log(`${LOG_PREFIX} window game-related keys:`, gameKeys);
      console.log(`${LOG_PREFIX} All window keys:`, keys);
    };

    root.querySelector('#pg-find-functions').onclick = () => {
      const fns = [];
      const search = (obj, path, depth = 0) => {
        if (depth > 2) return;
        try {
          Object.keys(obj || {}).forEach(k => {
            const full = `${path}.${k}`;
            if (/game|board|card|play|turn|organiz|arrange|zone|permanent/i.test(k)) {
              try {
                const val = obj[k];
                fns.push({ path: full, type: typeof val });
                if (typeof val === 'object' && val !== null) search(val, full, depth + 1);
              } catch (_) {}
            }
          });
        } catch (_) {}
      };
      search(window, 'window');
      addLogEntry('GAME-FUNCTIONS', 'window scan', fns);
      console.log(`${LOG_PREFIX} Found game-related:`, fns);
    };

    // ── Initial renders
    renderWizard();
    renderEventLog();
    renderConfigPanel();
    makeDraggable(root, root.querySelector('#pg-explorer-header'));

    // ── If selectors already set from storage, hook them up
    if (CONFIG.passTurnSelector) hookPassTurn();
    if (CONFIG.passTurnKey) hookPassTurnKey();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DRAG TO REPOSITION
  // ─────────────────────────────────────────────────────────────────────────────
  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, startX = 0, startY = 0;
    handle.onmousedown = (e) => {
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;
      const onMove = (e) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        el.style.left = `${ox + dx}px`;
        el.style.top = `${oy + dy}px`;
        el.style.right = 'auto';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // BOOT
  // ─────────────────────────────────────────────────────────────────────────────
  render();
  startGlobalWatchers(); // always-on passive watchers

  log('Explorer loaded. Open the panel to begin the setup wizard.');
  log('Discovered config:', CONFIG);

})();
