(() => {
  'use strict';

  const sessionId = window.__SESSION_ID__;
  const POLL_MS = 2500;
  // ark ページを含むタブでは「レビュー終了」ボタン（ark サーバを停止させる）を
  // 押させないための常設注意書きを出す
  const ARK_NOTICE = '承認・完了はこの上部バーのボタンで行ってください。タブ内の「レビュー終了」ボタンは押さないでください（レビュー画面が停止します）。';

  const el = {
    title: document.getElementById('session-title'),
    tabs: document.getElementById('tabs'),
    hiddenTabs: document.getElementById('hidden-tabs'),
    hiddenTabsBtn: document.getElementById('hidden-tabs-btn'),
    hiddenTabsCount: document.getElementById('hidden-tabs-count'),
    hiddenTabsMenu: document.getElementById('hidden-tabs-menu'),
    tabContextMenu: document.getElementById('tab-context-menu'),
    hideTabItem: document.getElementById('hide-tab-item'),
    conn: document.getElementById('conn'),
    statusBar: document.getElementById('status-bar'),
    phaseSteps: document.getElementById('phase-steps'),
    statusNote: document.getElementById('status-note'),
    statusMeta: document.getElementById('status-meta'),
    interruptBtn: document.getElementById('interrupt-btn'),
    memoBtn: document.getElementById('memo-btn'),
    memoModal: document.getElementById('memo-modal'),
    memoTime: document.getElementById('memo-time'),
    memoText: document.getElementById('memo-text'),
    memoClose: document.getElementById('memo-close'),
    notice: document.getElementById('notice'),
    approvalBar: document.getElementById('approval-bar'),
    approvalLabel: document.getElementById('approval-label'),
    approveBtn: document.getElementById('approve-btn'),
    approvedMark: document.getElementById('approved-mark'),
    approvalReceipt: document.getElementById('approval-receipt'),
    frames: document.getElementById('frames'),
    empty: document.getElementById('empty'),
  };

  let session = null;
  let activeTabId = null;
  let draggingTabId = null; // ドラッグ中はタブバーの再構築を止める（つかんだ要素が消えるため）
  let hiddenMenuOpen = false;
  let contextTabId = null; // 右クリックメニューの対象タブ
  const frames = new Map(); // tabId -> {iframe, url, overlay}

  function api(path, options) {
    return fetch(path, options).then((res) => {
      if (!res.ok) return res.json().then((b) => Promise.reject(new Error(b.error || res.statusText)));
      return res.json();
    });
  }

  function activeTab() {
    return session && session.tabs.find((t) => t.id === activeTabId);
  }

  // 表示中のタブ。リロードしても同じタブに戻れるよう localStorage に持つ（並び順と同じ扱い）
  function activeTabKey() {
    return `review-hub-activetab-${sessionId}`;
  }

  function loadActiveTabId() {
    try {
      return localStorage.getItem(activeTabKey()) || null;
    } catch {
      return null;
    }
  }

  function saveActiveTabId(id) {
    try {
      localStorage.setItem(activeTabKey(), id);
    } catch {
      /* localStorage 不可でも表示自体は成立する */
    }
  }

  function selectTab(id) {
    activeTabId = id;
    render();
  }

  // タブの並び順（ドラッグで入れ替え）。順序は自分のブラウザだけの好みなので
  // localStorage に持つ。エージェントが後から追加したタブは末尾に並ぶ
  function tabOrderKey() {
    return `review-hub-taborder-${sessionId}`;
  }

  function orderedTabs() {
    let saved = [];
    try {
      saved = JSON.parse(localStorage.getItem(tabOrderKey())) || [];
    } catch {
      saved = [];
    }
    const rest = new Map(session.tabs.map((t) => [t.id, t]));
    const ordered = [];
    for (const id of saved) {
      const tab = rest.get(id);
      if (tab) {
        ordered.push(tab);
        rest.delete(id);
      }
    }
    for (const tab of session.tabs) {
      if (rest.has(tab.id)) ordered.push(tab);
    }
    return ordered;
  }

  // 非表示タブ（右クリック → 「このタブを非表示」）。並び順と違い hub 側（session.json）に
  // 記録する: エージェントが「非表示タブ宛のコメント待ち受けは不要」と判断できるようにするため。
  // iframe は残すので ark の下書きやポーリングは生きたまま
  function hiddenTabIds() {
    return new Set(session.tabs.filter((t) => t.hidden).map((t) => t.id));
  }

  function setTabHidden(id, hidden) {
    // 先にローカルへ反映して即描画し、その後サーバに記録する（次のポーリングで確定）
    for (const t of session.tabs) if (t.id === id) t.hidden = hidden;
    if (!hidden) activeTabId = id;
    if (hiddenTabIds().size === 0) hiddenMenuOpen = false;
    render();
    api(`/api/session/${encodeURIComponent(sessionId)}/tab-visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: id, hidden }),
    })
      .then(() => refresh())
      .catch((err) => window.alert(`タブの表示切替に失敗しました: ${err.message}`));
  }

  function hideTab(id) {
    setTabHidden(id, true);
  }

  function showTab(id) {
    setTabHidden(id, false);
  }

  function visibleTabs() {
    const hidden = hiddenTabIds();
    return orderedTabs().filter((t) => !hidden.has(t.id));
  }

  // ドラッグ終了時、DOM 上のボタンの並びを保存する。非表示タブは DOM に無いので
  // 元の位置に据え置き、表示中のタブだけ DOM の並びで置き換える
  function commitTabOrder() {
    draggingTabId = null;
    const domIds = Array.from(el.tabs.children)
      .map((btn) => btn.dataset.tabId)
      .filter(Boolean);
    const hidden = hiddenTabIds();
    let k = 0;
    const ids = orderedTabs().map((t) => (hidden.has(t.id) ? t.id : domIds[k++])).filter(Boolean);
    try {
      localStorage.setItem(tabOrderKey(), JSON.stringify(ids));
    } catch {
      /* localStorage 不可でもその場の並べ替えは効いている */
    }
    render();
  }

  el.tabs.addEventListener('dragover', (e) => {
    if (!draggingTabId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const dragged = el.tabs.querySelector('.tab.dragging');
    const target = e.target.closest ? e.target.closest('.tab') : null;
    if (!dragged || !target || target === dragged) return;
    // ポインタが対象タブの中央より右なら後ろへ、左なら前へ差し込む
    const rect = target.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    el.tabs.insertBefore(dragged, after ? target.nextSibling : target);
  });
  el.tabs.addEventListener('drop', (e) => {
    if (!draggingTabId) return;
    e.preventDefault();
    commitTabOrder();
  });

  // タブ・非表示メニューの件数バッジ。ark サイドバーと同じスレッド単位の
  // 「要確認」（ユーザーの確認待ち。赤）と「未解決」（エージェントの作業待ち。青）を
  // 数字だけで並べる（意味は title と色で伝える。色は ark の tree-count に合わせる）
  function appendCountBadges(parent, tab) {
    if (typeof tab.check === 'number' && tab.check > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-check';
      badge.title = '要確認: 回答・修正・見送りの確認待ち、または AI 指摘への返信待ちのスレッド';
      badge.textContent = String(tab.check);
      parent.appendChild(badge);
    }
    if (typeof tab.unresolved === 'number' && tab.unresolved > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-open';
      badge.title = '未解決: エージェントの対応待ちのスレッド';
      badge.textContent = String(tab.unresolved);
      parent.appendChild(badge);
    }
  }

  function ensureFrame(tab) {
    let entry = frames.get(tab.id);
    if (!entry) {
      const iframe = document.createElement('iframe');
      iframe.hidden = true;
      const overlay = document.createElement('div');
      overlay.className = 'dead-overlay';
      overlay.hidden = true;
      el.frames.appendChild(iframe);
      el.frames.appendChild(overlay);
      entry = { iframe, url: null, overlay };
      frames.set(tab.id, entry);
    }
    // ark 再起動でポートが変わった場合のみ差し替える（無闇な再読込を避ける）
    if (tab.url && entry.url !== tab.url) {
      entry.iframe.src = tab.url;
      entry.url = tab.url;
    }
    return entry;
  }

  // 中断メモ（自分用）。中断中はもちろん、再開後も lastInterrupt として残るので
  // ヘッダのボタンからいつでも読み返せる。未読のメモはページを開いたとき一度だけ自動表示する
  function currentMemo() {
    const memo = session.interrupted || session.lastInterrupt;
    return memo && memo.note ? memo : null;
  }

  function memoSeenKey() {
    return `review-hub-memo-seen-${sessionId}`;
  }

  function showMemo(memo) {
    el.memoTime.textContent = new Date(memo.at).toLocaleString();
    el.memoText.textContent = memo.note;
    el.memoModal.hidden = false;
    try {
      localStorage.setItem(memoSeenKey(), memo.at);
    } catch {
      /* localStorage 不可でも表示自体は成立する */
    }
  }

  let memoAutoChecked = false;
  function autoShowMemoOnce() {
    if (memoAutoChecked) return;
    memoAutoChecked = true;
    const memo = currentMemo();
    let seen = null;
    try {
      seen = localStorage.getItem(memoSeenKey());
    } catch {
      /* ignore */
    }
    if (memo && seen !== memo.at) showMemo(memo);
  }

  // ステータスバー: フェーズ進行・作業メモ・承認/コメント集計・中断ボタン。
  // 旧セッション（phases なし）ではバーごと隠す
  function renderStatusBar() {
    const phases = session.phases || [];
    const st = session.status || {};
    const interrupted = session.interrupted || null;
    const visible = phases.length > 0 || st.phase || st.note || interrupted;
    el.statusBar.hidden = !visible;
    if (!visible) return;
    el.statusBar.classList.toggle('interrupted', Boolean(interrupted));

    el.phaseSteps.textContent = '';
    const cur = phases.indexOf(st.phase);
    phases.forEach((phase, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '›';
        el.phaseSteps.appendChild(sep);
      }
      const step = document.createElement('span');
      step.className = `step${i < cur ? ' done' : i === cur ? ' current' : ''}`;
      step.textContent = i < cur ? `✓ ${phase}` : phase;
      el.phaseSteps.appendChild(step);
    });

    el.statusNote.textContent = st.note || '';
    el.statusNote.title = st.note || '';

    const parts = [];
    if (interrupted) {
      parts.push(`⏸ 中断中 (${new Date(interrupted.at).toLocaleString()}${interrupted.note ? ` — ${interrupted.note}` : ''})`);
    }
    const checkTotal = session.tabs.reduce((n, t) => n + (typeof t.check === 'number' ? t.check : 0), 0);
    const unresolvedTotal = session.tabs.reduce((n, t) => n + (typeof t.unresolved === 'number' ? t.unresolved : 0), 0);
    if (checkTotal > 0) parts.push(`要確認 ${checkTotal}件`);
    if (unresolvedTotal > 0) parts.push(`未解決 ${unresolvedTotal}件`);
    const pending = session.tabs.filter((t) => t.approval && !t.approval.approvedAt).map((t) => t.approval.label || t.title);
    if (pending.length > 0) parts.push(`承認待ち: ${pending.join(' / ')}`);
    const unreceived = session.tabs.filter((t) => approvalUnreceived(t.approval)).map((t) => t.approval.label || t.title);
    if (unreceived.length > 0) parts.push(`承認の未受信: ${unreceived.join(' / ')}`);
    if (!interrupted && st.updatedAt) parts.push(`更新 ${new Date(st.updatedAt).toLocaleString()}`);
    el.statusMeta.textContent = parts.join('　');

    el.interruptBtn.hidden = Boolean(interrupted);
  }

  // ヘッダの「非表示 N ▾」ボタンとその一覧。未解決コメント・承認待ちがある非表示タブは
  // 見落とさないよう印を付ける
  function renderHiddenTabsMenu() {
    const hidden = hiddenTabIds();
    const tabs = orderedTabs().filter((t) => hidden.has(t.id));
    el.hiddenTabs.hidden = tabs.length === 0;
    if (tabs.length === 0) {
      hiddenMenuOpen = false;
      el.hiddenTabsMenu.hidden = true;
      return;
    }
    el.hiddenTabsCount.textContent = String(tabs.length);
    el.hiddenTabsMenu.hidden = !hiddenMenuOpen;
    el.hiddenTabsMenu.textContent = '';
    for (const tab of tabs) {
      const row = document.createElement('div');
      row.className = 'hidden-tab-row';
      const label = document.createElement('span');
      label.className = 'hidden-tab-title';
      label.textContent = tab.title;
      row.appendChild(label);
      appendCountBadges(row, tab);
      if (tab.approval && !tab.approval.approvedAt) {
        const pending = document.createElement('span');
        pending.className = 'pending';
        pending.textContent = '承認待ち';
        row.appendChild(pending);
      }
      const btn = document.createElement('button');
      btn.textContent = '再表示';
      btn.addEventListener('click', () => showTab(tab.id));
      row.appendChild(btn);
      el.hiddenTabsMenu.appendChild(row);
    }
    if (tabs.length > 1) {
      const all = document.createElement('button');
      all.className = 'show-all';
      all.textContent = 'すべて再表示';
      all.addEventListener('click', () => {
        for (const t of tabs) showTab(t.id);
      });
      el.hiddenTabsMenu.appendChild(all);
    }
  }

  function openTabContextMenu(tabId, x, y) {
    contextTabId = tabId;
    el.tabContextMenu.hidden = false;
    // 画面右端・下端からはみ出さないように寄せる
    const w = el.tabContextMenu.offsetWidth;
    const h = el.tabContextMenu.offsetHeight;
    el.tabContextMenu.style.left = `${Math.min(x, window.innerWidth - w - 4)}px`;
    el.tabContextMenu.style.top = `${Math.min(y, window.innerHeight - h - 4)}px`;
  }

  function closeTabContextMenu() {
    contextTabId = null;
    el.tabContextMenu.hidden = true;
  }

  el.hideTabItem.addEventListener('click', () => {
    const id = contextTabId;
    closeTabContextMenu();
    if (id) hideTab(id);
  });
  el.hiddenTabsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hiddenMenuOpen = !hiddenMenuOpen;
    render();
  });
  el.hiddenTabsMenu.addEventListener('click', (e) => e.stopPropagation());
  // メニュー外クリック・Esc で両メニューを閉じる
  document.addEventListener('click', () => {
    closeTabContextMenu();
    if (hiddenMenuOpen) {
      hiddenMenuOpen = false;
      render();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeTabContextMenu();
    if (hiddenMenuOpen) {
      hiddenMenuOpen = false;
      render();
    }
  });
  window.addEventListener('blur', closeTabContextMenu); // iframe をクリックしたときも閉じる

  function renderMemoButton() {
    el.memoBtn.hidden = !currentMemo();
  }

  function render() {
    if (!session) return;
    // ドラッグ中の再構築はつかんだ要素を DOM から消してしまうので、次のポーリングに回す
    if (draggingTabId) return;
    document.title = `${session.title} - review-hub`;
    el.title.textContent = session.title;
    renderStatusBar();
    renderMemoButton();

    const tabs = visibleTabs();
    if (tabs.length === 0) {
      el.empty.hidden = false;
      el.empty.textContent =
        session.tabs.length > 0
          ? 'すべてのタブが非表示です。上部の「非表示」メニューから再表示できます。'
          : 'タブがまだありません。エージェントがタブを追加するとここに表示されます。';
    } else {
      el.empty.hidden = true;
      // 初回描画（リロード直後）は前回見ていたタブに戻す。無ければ先頭
      if (!activeTabId) activeTabId = loadActiveTabId();
      if (!activeTabId || !tabs.some((t) => t.id === activeTabId)) {
        activeTabId = tabs[0].id;
      }
      saveActiveTabId(activeTabId);
    }

    // タブバー
    el.tabs.textContent = '';
    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.className = `tab${tab.id === activeTabId ? ' active' : ''}`;
      btn.dataset.tabId = tab.id;
      btn.draggable = true;
      btn.addEventListener('click', () => selectTab(tab.id));
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openTabContextMenu(tab.id, e.clientX, e.clientY);
      });
      btn.addEventListener('dragstart', (e) => {
        draggingTabId = tab.id;
        btn.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.id); // Firefox はデータが無いとドラッグを開始しない
      });
      btn.addEventListener('dragend', () => {
        btn.classList.remove('dragging');
        if (draggingTabId) commitTabOrder(); // ドロップ枠の外で離した場合もその場の並びで確定する
      });
      const label = document.createElement('span');
      label.textContent = tab.title;
      btn.appendChild(label);
      appendCountBadges(btn, tab);
      if (tab.approval && tab.approval.approvedAt) {
        const check = document.createElement('span');
        check.className = 'check';
        check.title = `承認済み: ${tab.approval.approvedAt}`;
        check.textContent = '✓';
        btn.appendChild(check);
      }
      if (tab.alive === false) {
        const dead = document.createElement('span');
        dead.className = 'dead';
        dead.title = 'ページのサーバに接続できません';
        dead.textContent = '!';
        btn.appendChild(dead);
      }
      el.tabs.appendChild(btn);
    }
    renderHiddenTabsMenu();

    // iframe の表示切替（アンマウントしない: 非表示でも ark のポーリングと下書きを生かす）
    for (const tab of session.tabs) {
      const entry = ensureFrame(tab);
      const isActive = tab.id === activeTabId;
      const dead = tab.alive === false;
      entry.iframe.hidden = !isActive || (dead && !entry.url);
      entry.overlay.hidden = !isActive || !dead;
      if (dead) {
        entry.overlay.textContent =
          tab.type === 'static'
            ? `このタブの参照先が見つかりません:\n${tab.path || ''}`
            : session.interrupted
              ? '中断中のためレビューサーバ (agent-review-kit) は停止しています。\nセッションを再開すると自動的に復帰します。'
              : 'レビューサーバ (agent-review-kit) に接続できません。\nエージェント側で serve を再起動すると自動的に復帰します。';
      }
    }
    // 消えたタブの iframe を片付ける
    for (const [id, entry] of frames) {
      if (!session.tabs.some((t) => t.id === id)) {
        entry.iframe.remove();
        entry.overlay.remove();
        frames.delete(id);
      }
    }

    // 注意書きと承認バー（アクティブタブに対して）
    const tab = activeTab();
    const isArk = tab && (tab.type === 'ark-doc' || tab.type === 'ark-diff');
    el.notice.hidden = !isArk;
    if (isArk) {
      el.notice.classList.remove('error');
      el.notice.textContent = ARK_NOTICE;
    }
    if (tab && tab.approval) {
      el.approvalBar.hidden = false;
      const approved = Boolean(tab.approval.approvedAt);
      el.approvalLabel.textContent = tab.approval.label || '承認';
      el.approveBtn.hidden = approved;
      el.approvedMark.hidden = !approved;
      el.approvedMark.textContent = approved ? `✓ 承認済み (${new Date(tab.approval.approvedAt).toLocaleString()})` : '';
      renderApprovalReceipt(tab.approval);
    } else {
      el.approvalBar.hidden = true;
    }
  }

  // 承認コメントがエージェントに配達されたか（hub が ark のコメント状態から判定）。
  // 配達は待ち受けが生きていれば数秒で済むので、しばらく未受信なら待ち受け停止を疑う表示にする
  const RECEIPT_STALE_MS = 60 * 1000;
  function approvalUnreceived(approval) {
    return Boolean(approval && approval.approvedAt && approval.received === false);
  }
  function renderApprovalReceipt(approval) {
    const r = el.approvalReceipt;
    if (!approval || !approval.approvedAt || typeof approval.received !== 'boolean') {
      r.hidden = true;
      return;
    }
    r.hidden = false;
    const stale = approvalUnreceived(approval) && Date.now() - new Date(approval.approvedAt).getTime() > RECEIPT_STALE_MS;
    r.classList.toggle('stale', stale);
    if (approval.received) r.textContent = 'エージェント受信済み';
    else if (stale) r.textContent = '⚠ エージェントが未受信です。待ち受けが止まっている可能性があるので、エージェントに「承認を確認して」と伝えてください';
    else r.textContent = 'エージェントの受信待ち…';
  }

  el.approveBtn.addEventListener('click', () => {
    const tab = activeTab();
    if (!tab || !tab.approval) return;
    const label = tab.approval.label || `${tab.title} を承認`;
    if (!window.confirm(`「${label}」を実行します。よろしいですか？`)) return;
    api(`/api/session/${encodeURIComponent(sessionId)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: tab.id }),
    })
      .then(() => refresh())
      .catch((err) => window.alert(`承認に失敗しました: ${err.message}`));
  });

  el.interruptBtn.addEventListener('click', () => {
    const note = window.prompt('このセッションの作業を中断し、レビュー用のサーバを停止します（他のチケットのセッションは止めません）。\n自分用のメモ（任意・再開時に表示されます）:', '');
    if (note === null) return; // キャンセル
    api(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(note ? { note } : {}),
    })
      .then((res) => {
        // このセッションのタブはつながらなくなる（hub もこの直後に止まることがある）ため、
        // リロードせず終了メッセージで固定する
        const others = res.otherActive && res.otherActive.length ? `\n（動いている他のセッション: ${res.otherActive.join(', ')}）` : '';
        const overlay = document.createElement('div');
        overlay.id = 'shutdown-overlay';
        overlay.textContent =
          `⏸ 中断しました。このセッションのレビュー用サーバを停止しました。${others}\nこのタブは閉じて大丈夫です。\n再開するときはエージェントに「再開して」と伝えてください。`;
        document.body.appendChild(overlay);
      })
      .catch((err) => window.alert(`中断の記録に失敗しました: ${err.message}`));
  });

  el.memoBtn.addEventListener('click', () => {
    const memo = currentMemo();
    if (memo) showMemo(memo);
  });
  el.memoClose.addEventListener('click', () => {
    el.memoModal.hidden = true;
  });
  el.memoModal.addEventListener('click', (e) => {
    if (e.target === el.memoModal) el.memoModal.hidden = true;
  });

  function refresh() {
    return api(`/api/session/${encodeURIComponent(sessionId)}`)
      .then((data) => {
        session = data;
        el.conn.classList.remove('offline');
        render();
        autoShowMemoOnce();
      })
      .catch(() => {
        el.conn.classList.add('offline');
      });
  }

  refresh();
  setInterval(refresh, POLL_MS);
})();
