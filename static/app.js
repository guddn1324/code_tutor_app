const codeInput = document.getElementById("code-input");
const submitBtn = document.getElementById("submit-btn");
const output = document.getElementById("output");

let sections = [];
let currentCode = "";
let sectionAbortController = null;
let currentSessionId = null;
let qaHistory = [];
let sectionCache = {};
let mergeGroups = [];
let selectedGroups = new Set();
let selectionMode = false;
let explainMode = localStorage.getItem("explain-mode") || "auto";
let pendingExplain = null;

// ── Auth ──────────────────────────────────────────────────────

let authToken = localStorage.getItem("auth-token");
let isAdmin = localStorage.getItem("is-admin") === "1";
const authModal = document.getElementById("auth-modal");
let currentAuthTab = "login";

function authFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {}),
    },
  });
}

async function apiFetch(url, options = {}) {
  const res = await authFetch(url, options);
  if (res.status === 401) {
    authToken = null;
    isAdmin = false;
    localStorage.removeItem("auth-token");
    localStorage.removeItem("is-admin");
    authModal.hidden = false;
    updateAuthButton();
    throw new Error("Unauthorized");
  }
  return res;
}

document.querySelectorAll(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    currentAuthTab = tab.dataset.authTab;
    document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("auth-submit").textContent =
      currentAuthTab === "login" ? "로그인" : "회원가입";
    document.getElementById("auth-error").hidden = true;
  });
});

document.getElementById("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("auth-email").value;
  const password = document.getElementById("auth-password").value;
  const errorEl = document.getElementById("auth-error");
  const submitEl = document.getElementById("auth-submit");

  submitEl.disabled = true;
  errorEl.hidden = true;

  try {
    const res = await fetch(`/auth/${currentAuthTab}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.detail || "오류가 발생했어요";
      errorEl.hidden = false;
      return;
    }
    authToken = data.token;
    isAdmin = data.is_admin || false;
    localStorage.setItem("auth-token", authToken);
    localStorage.setItem("is-admin", isAdmin ? "1" : "0");
    authModal.hidden = true;
    updateAuthButton();
    loadSessions();
  } catch {
    errorEl.textContent = "서버 연결 오류";
    errorEl.hidden = false;
  } finally {
    submitEl.disabled = false;
  }
});

const authFloatingBtn = document.getElementById("login-floating-btn");
const adminBtn = document.getElementById("admin-btn");

function updateAuthButton() {
  if (authToken) {
    authFloatingBtn.textContent = "로그아웃";
    authFloatingBtn.hidden = false;
    adminBtn.hidden = !isAdmin;
  } else {
    authFloatingBtn.textContent = "로그인 / 회원가입";
    authFloatingBtn.hidden = false;
    adminBtn.hidden = true;
  }
}

authFloatingBtn.addEventListener("click", () => {
  if (authToken) {
    authToken = null;
    isAdmin = false;
    localStorage.removeItem("auth-token");
    localStorage.removeItem("is-admin");
    currentSessionId = null;
    currentCode = "";
    sections = [];
    sectionCache = {};
    output.hidden = true;
    codeInput.value = "";
    updateAuthButton();
    loadSessions();
  } else {
    authModal.hidden = false;
  }
});

document.getElementById("guest-btn").addEventListener("click", () => {
  authModal.hidden = true;
  updateAuthButton();
  loadSessions();
});

// ── Admin panel ───────────────────────────────────────────────

adminBtn.addEventListener("click", () => {
  document.getElementById("admin-modal").hidden = false;
  loadAdminPanel();
});

document.getElementById("admin-close-btn").addEventListener("click", () => {
  document.getElementById("admin-modal").hidden = true;
});

async function loadAdminPanel() {
  const list = document.getElementById("admin-user-list");
  list.innerHTML = '<p class="no-sessions">불러오는 중...</p>';
  try {
    const res = await apiFetch("/admin/users");
    const users = await res.json();
    renderAdminPanel(users);
  } catch {
    list.innerHTML = '<p class="no-sessions">불러오기 실패</p>';
  }
}

function renderAdminPanel(users) {
  const list = document.getElementById("admin-user-list");
  if (!users.length) {
    list.innerHTML = '<p class="no-sessions">가입한 유저가 없어요</p>';
    return;
  }
  list.innerHTML = users.map((u) => `
    <div class="admin-user-row">
      <div class="admin-user-email">${escapeHtml(u.email)}</div>
      <div class="admin-user-actions">
        ${u.is_admin
          ? '<span class="badge badge-admin">관리자</span>'
          : u.is_approved
            ? `<span class="badge badge-approved">승인됨</span>
               <button class="admin-action-btn revoke-btn" onclick="toggleApproval(${u.id}, true)">취소</button>`
            : `<span class="badge badge-pending">대기중</span>
               <button class="admin-action-btn approve-btn" onclick="toggleApproval(${u.id}, false)">승인</button>`
        }
      </div>
    </div>
  `).join("");
}

async function toggleApproval(userId, currentlyApproved) {
  const action = currentlyApproved ? "revoke" : "approve";
  try {
    await apiFetch(`/admin/users/${userId}/${action}`, { method: "POST" });
    loadAdminPanel();
  } catch {}
}

// ── Session management (server) ───────────────────────────────

async function loadSessions() {
  if (!authToken) {
    document.getElementById("session-list").innerHTML =
      '<p class="no-sessions">로그인하면 분석 기록이 저장돼요</p>';
    return;
  }
  try {
    const res = await apiFetch("/api/sessions");
    const data = await res.json();
    renderSidebarFromData(data);
  } catch {}
}

async function saveSession(code, overall, secs, title) {
  if (!authToken) return;

  const id = Date.now().toString();
  title = title || code.split("\n").find((l) => l.trim()) || "코드";
  const created_at = new Date().toISOString();

  currentSessionId = id;

  try {
    await apiFetch("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ id, title, code, overall, sections: secs, created_at }),
    });
    loadSessions();
  } catch {}
}

async function restoreSession(id) {
  try {
    const res = await apiFetch(`/api/sessions/${id}`);
    const session = await res.json();

    currentSessionId = id;
    currentCode = session.code;
    sectionCache = session.section_explanations || {};

    codeInput.value = session.code;
    output.hidden = false;

    document.getElementById("overall-explanation").innerHTML = marked.parse(session.overall || "");
    renderSections(session.sections || [], session.merge_groups || null);
    document.getElementById("chat-messages").innerHTML =
      '<p class="hint">👈 코드에서 원하는 부분을 클릭하세요.</p>';
    qaHistory = [];
    document.getElementById("qa-input-area").hidden = true;

    loadSessions();
    output.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch {}
}

async function deleteSession(e, id) {
  e.stopPropagation();
  try {
    await apiFetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (currentSessionId === id) {
      currentSessionId = null;
      output.hidden = true;
      codeInput.value = "";
      currentCode = "";
    }
    loadSessions();
  } catch {}
}

function renderSidebarFromData(sessions) {
  const list = document.getElementById("session-list");

  if (sessions.length === 0) {
    list.innerHTML = '<p class="no-sessions">저장된 세션이 없어요</p>';
    return;
  }

  list.innerHTML = sessions
    .map(
      (s) => `
    <div class="session-item ${s.id === currentSessionId ? "active" : ""}"
         onclick="restoreSession('${s.id}')">
      <div class="session-title">${escapeHtml(s.title || "제목 없음")}</div>
      <div class="session-time">${formatTime(s.created_at)}</div>
      <button class="session-delete" onclick="deleteSession(event, '${s.id}')" title="삭제">✕</button>
    </div>`
    )
    .join("");
}

document.getElementById("select-mode-btn").addEventListener("click", toggleSelectionMode);

document.getElementById("new-btn").addEventListener("click", () => {
  currentSessionId = null;
  currentCode = "";
  codeInput.value = "";
  output.hidden = true;
  loadSessions();
  codeInput.focus();
});

// ── Submit ────────────────────────────────────────────────────

submitBtn.addEventListener("click", async () => {
  const code = codeInput.value.trim();
  if (!code) return;

  if (!authToken) {
    authModal.hidden = false;
    return;
  }

  currentCode = code;
  currentSessionId = null;
  submitBtn.disabled = true;
  output.hidden = false;
  output.scrollIntoView({ behavior: "smooth", block: "start" });

  document.getElementById("code-sections").innerHTML = '<div class="loading">코드 분석 중...</div>';
  document.getElementById("overall-explanation").innerHTML = "";
  document.getElementById("chat-messages").innerHTML =
    '<p class="hint">👈 코드에서 원하는 부분을 클릭하세요.</p>';
  qaHistory = [];
  sectionCache = {};
  document.getElementById("qa-input-area").hidden = true;

  if (sectionAbortController) sectionAbortController.abort();

  const [fetchedSections, overallText, fetchedTitle] = await Promise.all([
    fetchSections(code),
    streamText("/explain", { code }, document.getElementById("overall-explanation")),
    fetchTitle(code),
  ]);

  renderSections(fetchedSections || []);
  saveSession(code, overallText || "", fetchedSections || [], fetchedTitle);
  submitBtn.disabled = false;
});

// ── AI helpers ────────────────────────────────────────────────

async function fetchTitle(code) {
  try {
    const res = await authFetch("/title", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    return data.title || "";
  } catch {
    return "";
  }
}

async function fetchSections(code) {
  try {
    const res = await authFetch("/sections", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.sections;
  } catch {
    return [];
  }
}

function renderSections(secs, savedMergeGroups = null) {
  sections = secs;
  mergeGroups = savedMergeGroups || secs.map((_, i) => [i]);
  selectedGroups = new Set();
  selectionMode = false;
  document.querySelector('.code-panel')?.classList.remove('selection-mode');
  updateSelectModeBtn();
  updateSelectAllButton();

  const container = document.getElementById("code-sections");
  container.innerHTML = "";

  mergeGroups.forEach((group, gIdx) => {
    const code = group.map(i => sections[i]).join("\n\n");
    const isMerged = group.length > 1;
    const groupKey = group.join("-");

    const row = document.createElement("div");
    row.className = "section-row" + (isMerged ? " merged" : "");

    const checkboxWrap = document.createElement("label");
    checkboxWrap.className = "merge-checkbox-wrap";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "merge-checkbox";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedGroups.add(gIdx);
      else selectedGroups.delete(gIdx);
      row.classList.toggle("selected-for-merge", checkbox.checked);
      updateSelectModeBtn();
      updateSelectAllButton();
    });
    checkboxWrap.appendChild(checkbox);
    row.appendChild(checkboxWrap);

    const div = document.createElement("div");
    div.className = "code-section" + (isMerged ? " merged" : "");

    if (isMerged) {
      const badge = document.createElement("div");
      badge.className = "merge-badge";
      badge.textContent = "병합됨 ";
      const unmergeBtn = document.createElement("button");
      unmergeBtn.className = "unmerge-btn";
      unmergeBtn.textContent = "해제";
      unmergeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        unmerge(gIdx);
      });
      badge.appendChild(unmergeBtn);
      div.appendChild(badge);
      const codeBody = document.createElement("div");
      codeBody.className = "section-body";
      codeBody.textContent = code;
      div.appendChild(codeBody);
    } else {
      div.textContent = code;
    }

    div.addEventListener("click", () => { if (!selectionMode) selectGroup(gIdx, groupKey, code); });
    row.appendChild(div);
    container.appendChild(row);
  });
}

function updateSelectModeBtn() {
  const btn = document.getElementById("select-mode-btn");
  if (!selectionMode) {
    btn.textContent = "선택하기";
    btn.className = "";
  } else if (canMerge()) {
    btn.textContent = "합치기";
    btn.className = "merge-ready";
  } else {
    btn.textContent = "취소";
    btn.className = "cancel-mode";
  }
}

function updateSelectAllButton() {
  const btn = document.getElementById("select-all-btn");
  btn.hidden = !selectionMode;
  if (!selectionMode) return;
  const allSelected = mergeGroups.length > 0 && selectedGroups.size === mergeGroups.length;
  btn.textContent = allSelected ? "전체 해제" : "전체 선택";
  btn.classList.toggle("deselect-mode", allSelected);
}

function toggleSelectionMode() {
  if (!selectionMode) {
    selectionMode = true;
    document.querySelector(".code-panel").classList.add("selection-mode");
    updateSelectModeBtn();
    updateSelectAllButton();
  } else if (canMerge()) {
    mergeSelected();
  } else {
    exitSelectionMode();
  }
}

function exitSelectionMode() {
  selectionMode = false;
  selectedGroups = new Set();
  document.querySelector(".code-panel").classList.remove("selection-mode");
  document.querySelectorAll(".merge-checkbox").forEach(cb => { cb.checked = false; });
  document.querySelectorAll(".section-row").forEach(row => row.classList.remove("selected-for-merge"));
  updateSelectModeBtn();
  updateSelectAllButton();
}

document.getElementById("select-all-btn").addEventListener("click", () => {
  const allSelected = mergeGroups.length > 0 && selectedGroups.size === mergeGroups.length;
  selectedGroups = new Set();
  document.querySelectorAll(".section-row").forEach((row, i) => {
    const cb = row.querySelector(".merge-checkbox");
    if (!allSelected) {
      selectedGroups.add(i);
      cb.checked = true;
      row.classList.add("selected-for-merge");
    } else {
      cb.checked = false;
      row.classList.remove("selected-for-merge");
    }
  });
  updateSelectModeBtn();
  updateSelectAllButton();
});

function canMerge() {
  if (selectedGroups.size < 2) return false;
  const sorted = [...selectedGroups].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return false;
  }
  return true;
}

function mergeSelected() {
  const sorted = [...selectedGroups].sort((a, b) => a - b);
  const newGroup = sorted.flatMap(i => mergeGroups[i]);
  const newGroups = [];
  let i = 0;
  while (i < mergeGroups.length) {
    if (i === sorted[0]) {
      newGroups.push(newGroup);
      i = sorted[sorted.length - 1] + 1;
    } else {
      newGroups.push(mergeGroups[i]);
      i++;
    }
  }

  renderSections(sections, newGroups);

  const newGroupIdx = newGroups.findIndex(g => g === newGroup);
  const code = newGroup.map(i => sections[i]).join("\n\n");
  const groupKey = newGroup.join("-");
  selectGroup(newGroupIdx, groupKey, code);

  if (currentSessionId) saveMergeGroups();
}

function unmerge(gIdx) {
  const group = mergeGroups[gIdx];
  const groupKey = group.join("-");
  delete sectionCache[groupKey];

  const newGroups = [
    ...mergeGroups.slice(0, gIdx),
    ...group.map(i => [i]),
    ...mergeGroups.slice(gIdx + 1),
  ];
  renderSections(sections, newGroups);

  if (currentSessionId) {
    authFetch(`/api/sessions/${currentSessionId}/sections/${groupKey}`, { method: "DELETE" });
    saveMergeGroups();
  }
}

function selectGroup(gIdx, groupKey, code) {
  if (sectionAbortController) sectionAbortController.abort();

  document.querySelectorAll(".section-row").forEach((row, i) => {
    row.classList.toggle("active", i === gIdx);
  });

  qaHistory = [];
  const chatEl = document.getElementById("chat-messages");
  chatEl.innerHTML = "";
  pendingExplain = null;
  document.getElementById("explain-now-btn").hidden = true;
  document.getElementById("qa-input-area").hidden = false;

  if (explainMode === "manual") {
    pendingExplain = { groupKey, code };
    const hintEl = document.createElement("p");
    hintEl.className = "hint";
    hintEl.textContent = "바로 질문하거나, 버튼을 눌러 설명을 먼저 볼 수 있어요.";
    chatEl.appendChild(hintEl);
    const explainBtn = document.createElement("button");
    explainBtn.className = "inline-explain-btn";
    explainBtn.textContent = "설명 보기 ✨";
    explainBtn.addEventListener("click", triggerExplain);
    chatEl.appendChild(explainBtn);
    return;
  }

  const msgEl = document.createElement("div");
  msgEl.className = "explanation-message";
  chatEl.appendChild(msgEl);
  loadExplanation(msgEl, groupKey, code);
}

function loadExplanation(msgEl, groupKey, code) {
  if (sectionCache[groupKey] !== undefined) {
    msgEl.innerHTML = marked.parse(sectionCache[groupKey]);
    return;
  }
  msgEl.innerHTML = '<div class="chat-loading"><span></span><span></span><span></span></div>';
  sectionAbortController = new AbortController();
  streamText(
    "/explain-section",
    { code_section: code },
    msgEl,
    sectionAbortController.signal
  ).then((text) => {
    if (text) {
      sectionCache[groupKey] = text;
      if (currentSessionId) {
        authFetch(`/api/sessions/${currentSessionId}/sections/${groupKey}`, {
          method: "POST",
          body: JSON.stringify({ explanation: text }),
        });
      }
    }
  });
}

function triggerExplain() {
  if (!pendingExplain) return;
  const { groupKey, code } = pendingExplain;
  pendingExplain = null;

  document.getElementById("explain-now-btn").hidden = true;

  const chatEl = document.getElementById("chat-messages");
  const hasQA = !!chatEl.querySelector(".qa-message-user");

  chatEl.querySelector(".inline-explain-btn")?.remove();
  chatEl.querySelector(".hint")?.remove();

  const msgEl = document.createElement("div");
  msgEl.className = "explanation-message";

  if (hasQA) {
    const wrapper = document.createElement("div");
    wrapper.className = "prepended-explanation";
    wrapper.appendChild(msgEl);
    chatEl.insertBefore(wrapper, chatEl.firstChild);
  } else {
    chatEl.appendChild(msgEl);
  }

  loadExplanation(msgEl, groupKey, code);
}

function collapseExplainButton() {
  const chatEl = document.getElementById("chat-messages");
  if (!chatEl.querySelector(".inline-explain-btn")) return;

  chatEl.querySelector(".hint")?.remove();
  chatEl.querySelector(".inline-explain-btn")?.remove();

  const btn = document.getElementById("explain-now-btn");
  btn.hidden = false;
  btn.onclick = triggerExplain;
}

async function saveMergeGroups() {
  if (!currentSessionId || !authToken) return;
  authFetch(`/api/sessions/${currentSessionId}/merge-groups`, {
    method: "POST",
    body: JSON.stringify({ merge_groups: mergeGroups }),
  });
}

async function streamText(url, body, targetEl, signal) {
  try {
    const res = await authFetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        authToken = null;
        isAdmin = false;
        localStorage.removeItem("auth-token");
        localStorage.removeItem("is-admin");
        authModal.hidden = false;
        updateAuthButton();
      }
      if (targetEl) targetEl.innerHTML = `<span class="error-msg">${data.detail || "오류가 발생했어요"}</span>`;
      return "";
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return fullText;
        try {
          fullText += JSON.parse(data).text;
          targetEl.innerHTML = marked.parse(fullText);
        } catch {}
      }
    }
    return fullText;
  } catch (e) {
    if (e.name !== "AbortError") throw e;
    return "";
  }
}


// ── Q&A ──────────────────────────────────────────────────────

const qaInput = document.getElementById("qa-input");
const qaBtn = document.getElementById("qa-btn");

async function sendQuestion() {
  const question = qaInput.value.trim();
  if (!question || !currentCode) return;

  qaInput.value = "";
  qaBtn.disabled = true;
  qaInput.disabled = true;

  if (explainMode === "manual") collapseExplainButton();
  appendQAMessage("user", question);
  const assistantEl = appendQAMessage("assistant", "");

  const fullText = await streamText(
    "/ask",
    { code: currentCode, question, history: qaHistory },
    assistantEl
  );

  qaHistory.push({ role: "user", content: question });
  qaHistory.push({ role: "assistant", content: fullText });

  if (currentSessionId && fullText) {
    authFetch(`/api/sessions/${currentSessionId}/qa`, {
      method: "POST",
      body: JSON.stringify({ role: "user", content: question }),
    });
    authFetch(`/api/sessions/${currentSessionId}/qa`, {
      method: "POST",
      body: JSON.stringify({ role: "assistant", content: fullText }),
    });
  }

  qaBtn.disabled = false;
  qaInput.disabled = false;
  qaInput.focus();
}

function appendQAMessage(role, text) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = `qa-message-${role}`;
  if (role === "user") {
    div.textContent = text;
  } else {
    div.innerHTML = text ? marked.parse(text) : "";
  }
  container.appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "end" });
  return div;
}

qaBtn.addEventListener("click", sendQuestion);
qaInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendQuestion();
  }
});

// ── Helpers ───────────────────────────────────────────────────

function formatTime(iso) {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${min}`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Init ──────────────────────────────────────────────────────

document.querySelectorAll(".explain-mode-btn").forEach(btn => {
  btn.classList.toggle("active", btn.dataset.mode === explainMode);
  btn.addEventListener("click", () => {
    explainMode = btn.dataset.mode;
    localStorage.setItem("explain-mode", explainMode);
    document.querySelectorAll(".explain-mode-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.mode === explainMode);
    });
  });
});

updateAuthButton();
if (authToken) {
  authModal.hidden = true;
  loadSessions();
}
