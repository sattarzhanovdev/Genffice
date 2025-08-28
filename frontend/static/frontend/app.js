
const BASE = `https://genffice.pythonanywhere.com/api`;

/* ==== Auth tokens (persist + auto refresh) & Global Loader ==== */
const LS_KEYS = { access: "genffice_access", refresh: "genffice_refresh", user: "genffice_user" };
let __activeRequests = 0;

function ensureLoaderDom() {
  if (document.getElementById("appLoader")) return;
  const style = document.createElement("style");
  style.id = "appLoaderStyles";
  style.textContent = `
  #appLoader{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(17,24,38,.25);backdrop-filter:saturate(120%) blur(2px);z-index:9999}
  #appLoader.show{display:flex}
  #appLoader .spinner{width:56px;height:56px;border-radius:50%;border:6px solid #e5e7eb;border-top-color:#0a73ff;animation:spin 0.9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}`;
  document.head.appendChild(style);
  const wrap = document.createElement("div");
  wrap.id = "appLoader";
  wrap.innerHTML = '<div class="spinner" aria-label="Загрузка…"></div>';
  document.body.appendChild(wrap);
}
function showLoader(){ ensureLoaderDom(); __activeRequests++; document.getElementById("appLoader").classList.add("show"); }
function hideLoader(){ if (__activeRequests>0) __activeRequests--; if (__activeRequests===0){ const n=document.getElementById("appLoader"); n && n.classList.remove("show"); } }

function saveTokens({ access, refresh, user }) {
  if (access) localStorage.setItem(LS_KEYS.access, access);
  if (refresh) localStorage.setItem(LS_KEYS.refresh, refresh);
  if (user) localStorage.setItem(LS_KEYS.user, user);
}
function getAccessTokenRaw(){ return localStorage.getItem(LS_KEYS.access) || null; }
function getRefreshToken(){ return localStorage.getItem(LS_KEYS.refresh) || null; }
function clearTokens(){ Object.values(LS_KEYS).forEach(k=>localStorage.removeItem(k)); token=null; }

function b64urlToString(s){
  try{
    s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4;
    if (pad) s += "=".repeat(4 - pad);
    return atob(s);
  }catch{ return ""; }
}
function jwtIsExpired(jwt){
  try{
    const part = (String(jwt || "").split(".")[1]) || "";
    const json = b64urlToString(part);
    const payload = JSON.parse(json || "{}");
    if (!payload.exp) return true; // без exp считаем просроченным → рефрешим
    const now = Math.floor(Date.now()/1000);
    return payload.exp <= now + 15; // 15s skew
  }catch{
    return true; // при ошибке парсинга считаем просроченным → рефрешим
  }
}

async function getValidAccessToken(){
  let acc = getAccessTokenRaw();
  if (acc && !jwtIsExpired(acc)) return acc;
  const refr = getRefreshToken();
  if (!refr) return null;
  try {
    showLoader();
    const r = await fetch(`${BASE}/auth/refresh/`, {
      method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ refresh: refr })
    });
    if (!r.ok) throw new Error("refresh failed");
    const data = await r.json();
    acc = data.access; token = acc; saveTokens({ access: acc });
    return acc;
  } catch { clearTokens(); return null; } finally { hideLoader(); }
}

async function apiFetch(url, opts={}){
  ensureLoaderDom(); showLoader();
  try {
    const headers = new Headers(opts.headers || {});
    let acc = await getValidAccessToken();
    if (acc) headers.set("Authorization", "Bearer "+acc);
    let resp = await fetch(url, { ...opts, headers });
    if (resp.status === 401){
      acc = await getValidAccessToken();
      if (acc){ headers.set("Authorization", "Bearer "+acc); resp = await fetch(url, { ...opts, headers }); }
    }
    if (resp.status === 401){
      clearTokens();
      try{
        document.getElementById("app").style.display = "none";
        document.getElementById("login").style.display = "block";
      }catch{}
    }
    return resp;
  } finally { hideLoader(); }
}

// --- Mermaid init (idempotent) ---
if (window.mermaid && !window.__mmdInitDone__) {
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: "default",
      flowchart: { htmlLabels: true, curve: "basis" },
      er: { useMaxWidth: true },
      sequence: { useMaxWidth: true }
    });
    window.__mmdInitDone__ = true;
  } catch {}
}
let token = null,
  currentDoc = null;

const $ = (id) => document.getElementById(id);
function pickContent(data) {
  const obj = Array.isArray(data) ? data[0] : data;
  return obj?.choices?.[0]?.message?.content || obj?.text || "";
}

/* ---------- Charts ---------- */
function renderCharts(root = document) {
  const blocks = root.querySelectorAll("pre > code");
  blocks.forEach((code) => {
    const lang = (code.className || "").toLowerCase();
    const isChart =
      lang.includes("language-chart") || lang.trim() === "chart";
    if (!isChart) return;
    let cfg;
    try {
      cfg = JSON.parse(code.textContent.trim());
    } catch {
      return;
    }
    const pre = code.parentElement,
      wrap = document.createElement("div");
    wrap.style.margin = "8px 0";
    const canvas = document.createElement("canvas");
    canvas.height = 320;
    wrap.appendChild(canvas);
    pre.replaceWith(wrap);
    try {
      new Chart(canvas.getContext("2d"), cfg);
    } catch (e) {
      // Fallback: if "funnel" type is not registered, render it as a horizontal bar chart
      const msg = (e && e.message) ? String(e.message) : "";
      const isFunnelRequested = (cfg && (cfg.type || "").toLowerCase() === "funnel");
      const isMissingCtrl = /not a registered controller/i.test(msg) && /funnel/i.test(msg);

      if (isFunnelRequested && isMissingCtrl) {
        // transform funnel config → horizontal bar to keep the document usable
        const barCfg = (function funnelAsBar(fcfg) {
          const safe = JSON.parse(JSON.stringify(fcfg || {}));
          const ds = (safe.data && safe.data.datasets && safe.data.datasets[0]) ? safe.data.datasets[0] : { data: [] };
          const labels = Array.isArray(safe.data?.labels) ? safe.data.labels : [];
          const data = Array.isArray(ds.data) ? ds.data : [];

          return {
            type: "bar",
            data: {
              labels,
              datasets: [{
                label: (ds.label || "Funnel"),
                data,
                borderWidth: 1
              }]
            },
            options: Object.assign({
              indexAxis: "y",
              responsive: true,
              plugins: {
                legend: { display: true },
                title: { display: !!safe.options?.plugins?.title?.text, text: safe.options?.plugins?.title?.text || "Funnel (bar fallback)" }
              },
              scales: {
                x: { beginAtZero: true }
              }
            }, safe.options || {})
          };
        })(cfg);

        try {
          const ctx = canvas.getContext("2d");
          new Chart(ctx, barCfg);

          // show a small notice that a fallback was applied
          const note = document.createElement("div");
          note.textContent = "⚠️ Плагин funnel для Chart.js не подключён — показан fallback (горизонтальный bar).";
          note.style.fontSize = "12px";
          note.style.color = "#884400";
          note.style.marginTop = "4px";
          wrap.appendChild(note);
        } catch (e2) {
          const err = document.createElement("div");
          err.textContent = "Ошибка Chart.js (fallback): " + e2.message;
          err.style.color = "#c00";
          wrap.appendChild(err);
        }
      } else {
        const err = document.createElement("div");
        err.textContent = "Ошибка Chart.js: " + msg;
        err.style.color = "#c00";
        wrap.appendChild(err);
      }
    }
  });
}

function ensureMermaidHeader(code) {
  const headerRe = /^\s*(flowchart|sequenceDiagram|classDiagram|stateDiagram-v2|journey|gantt|erDiagram|pie|mindmap)\b/i;
  // Если заголовка нет — по умолчанию делаем flowchart TD
  return headerRe.test(code.trimStart()) ? code : "flowchart TD\n" + code;
}

function sanitizeMermaid(code) {
  if (!code) return code;

  // 0) Remove BOM
  code = code.replace(/^\uFEFF/, "");

  // 1) Normalize line breaks
  code = code.replace(/\r\n?/g, "\n");

  // 2) Replace invisible / non-breaking spaces with normal space
  code = code.replace(/[\u00A0\u1680\u180E\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ");

  // 2.1) Strip bidi/ZWJ controls and normalize similar glyphs
  code = code.replace(/[\u200C\u200D\u200E\u200F\u061C]/g, "");      // ZWNJ/ZWJ/LRM/RLM/ALM
  code = code.replace(/[\u2795\uFE62\uFF0B]/g, "+");                  // plus variants -> ASCII
  code = code.replace(/[﹙（]/g, "(").replace(/[﹚）]/g, ")");        // full‑width parens -> ASCII

  // 3) Tabs -> spaces
  code = code.replace(/\t/g, "  ");

  // 4) Various dashes/minus -> ASCII hyphen
  code = code.replace(/[\u2010-\u2015\u2212]/g, "-");

  // 5) Rendered newlines inside labels
  code = code.replace(/\\n/g, "<br/>");

  // 6) Protect '---' inside labels so it's not treated as an edge
  code = code.replace(/\[([^[\]]*?)---([^[\]]*?)\]/g, "[$1—$2]");
  code = code.replace(/\(([^()]*?)---([^()]*?)\)/g, "($1—$2)");

  // 6.5) **Escape parentheses inside node/decision labels to avoid 'PS' parse errors**
  // Mermaid parser sometimes treats '(' or ')' in labels as port markers.
  // We replace them with HTML entities within [ ... ] and { ... } labels.
  code = code.replace(/\[([^[\]]*)\]/g, (m, inner) => {
    const safe = inner.replace(/\(/g, "&#40;").replace(/\)/g, "&#41;");
    return "[" + safe + "]";
  });
  code = code.replace(/\{([^{}]*)\}/g, (m, inner) => {
    const safe = inner.replace(/\(/g, "&#40;").replace(/\)/g, "&#41;");
    return "{" + safe + "}";
  });

  // 7) Line-wise cleanup
  code = code
    .split("\n")
    .map((line) => {
      // Right trim
      let s = line.replace(/\s+$/g, "");

      // Drop // comments (but keep http:// https://)
      s = s.replace(/(^|[^:])\/\/.*$/g, "$1").trimEnd();

      // Keep clean 'end' keyword (cut any trailing garbage)
      if (/^\s*end\b/i.test(s)) s = s.replace(/^(\s*end)\b.*$/i, "$1");

      // Cut garbage AFTER a closed node if it's not a valid continuation
      const validCont = /\s*(-->|---|-\.->|==>|===|:::|:|style\b|class\b|click\b|linkStyle\b)/;
      s = s.replace(/(\]|\))([ \t]+)(?!-->|---|-\.->|==>|===|:::|:|style\b|class\b|click\b|linkStyle\b).+$/u, "$1");

      // Remove dangling colon after node end (e.g. "A[Node] :")
      s = s.replace(/(\]|\))\s*:\s*$/u, "$1");

      return s;
    })
    .join("\n");

  // 7.1) Remove invisible tails after closing ] or )
  code = code
    .split("\n")
    .map((line) => line.replace(/(\]|\))\s*[\u200C\u200D\u200E\u200F\u061C]*\s*$/u, "$1"))
    .join("\n");

  // 8) Gantt: comment-out lines that look like bare labels without taskData
  if (/^\s*gantt\b/i.test(code.trimStart())) {
    const isDirective = (L) =>
      /^(gantt|title|dateFormat|axisFormat|excludes|todayMarker|tickInterval|section)\b/i.test(L);

    code = code
      .split("\n")
      .map((line) => {
        const L = line.trim();
        if (!L || L.startsWith("%%")) return line;
        if (isDirective(L)) return line;
        if (/:/.test(L)) return line;          // has taskData
        return line.replace(/^(\s*)/, "$1%% "); // neutralize
      })
      .join("\n");
  }

  // 9) Balance subgraph/end
  const openSub = (code.match(/^\s*subgraph\b/igm) || []).length;
  const closeEnd = (code.match(/^\s*end\b/igm) || []).length;
  if (openSub > closeEnd) {
    code += "\n" + "end\n".repeat(openSub - closeEnd);
  }

  // 9.5) Resolve conflicting diagram types.
  // If the text contains multiple diagram headers (e.g. "flowchart TD" and later "quadrantChart"),
  // keep the first encountered header and remove the others. Also drop a leading 'flowchart ...'
  // line if a non-flowchart header appears later (typical LLM artifact).
  (function normalizeDiagramType() {
    const types = [
      "quadrantChart",
      "gantt",
      "sequenceDiagram",
      "classDiagram",
      "stateDiagram-v2",
      "journey",
      "erDiagram",
      "pie",
      "mindmap",
      "flowchart"
    ];
    const typeLineRe = new RegExp("^\\s*(?:" + types.join("|") + ")\\b.*$", "gmi");
    const typeHeadRe = new RegExp("^\\s*(" + types.join("|") + ")\\b.*$", "mi");

    const matches = [...code.matchAll(typeLineRe)];
    if (matches.length > 1) {
      const keepLine = matches[0][0];                      // full line to keep
      const keepType = (keepLine.match(typeHeadRe) || [,""])[1] || "";
      const perLineTypeRe = new RegExp("^\\s*(?:" + types.join("|") + ")\\b", "i");

      code = code
        .split("\n")
        .filter((line) => {
          if (!perLineTypeRe.test(line)) return true;
          // keep only the very first header line we found
          return new RegExp("^\\s*" + keepType + "\\b", "i").test(line) && line === keepLine;
        })
        .join("\n");
    }

    // Special case: if there is 'quadrantChart' and also a 'flowchart' header above it, drop that flowchart line.
    const qPos = code.search(/^\s*quadrantChart\b/mi);
    const fPos = code.search(/^\s*flowchart\b/mi);
    if (qPos >= 0 && fPos >= 0 && fPos < qPos) {
      code = code.replace(/^\s*flowchart[^\n]*\n/mi, "");
    }
  })();

  // 9.6) quadrantChart syntax fixes:
  // - Quote axis labels if missing
  // - Normalize points "Label : x,y" -> "Label : [x, y]"
  if (/^\s*quadrantChart\b/i.test(code.trimStart())) {
    // x-axis / y-axis: wrap ends with quotes if they lack them
    code = code.replace(/^\s*x-axis\s+([^"\n]+?)\s*-->\s*([^"\n]+?)\s*$/gim, (m, a, b) => {
      return `x-axis "${a.trim()}" --> "${b.trim()}"`;
    });
    code = code.replace(/^\s*y-axis\s+([^"\n]+?)\s*-->\s*([^"\n]+?)\s*$/gim, (m, a, b) => {
      return `y-axis "${a.trim()}" --> "${b.trim()}"`;
    });

    // points: `"Label" : 0.8,0.9`  or  `Label : 0.8, 0.9`  -> `"Label" : [0.8, 0.9]`
    code = code.replace(
      /^\s*("?[^":]+?"?)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*$/gim,
      (m, label, x, y) => {
        const lbl = label.replace(/^"?|"?$/g, "").trim();
        return `"${lbl}" : [${x}, ${y}]`;
      }
    );
  }

  // 10) Ensure header (if missing)
  code = ensureMermaidHeader(code);

  return code;
}

// Рендер с предочисткой и понятной диагностикой
async function renderMermaid(root = document) {
  const codeBlocks = root.querySelectorAll("pre > code");
  let idx = 0;

  for (const code of codeBlocks) {
    const lang = (code.className || "").toLowerCase();
    const isMermaid = lang.includes("language-mermaid") || lang.trim() === "mermaid";
    if (!isMermaid) continue;

    const pre = code.parentElement;
    const raw = code.textContent || "";
    const graph = sanitizeMermaid(raw);
    const id = "mmd-" + (++idx);

    try {
      // --- Mermaid re-init safety (idempotent) ---
      if (window.mermaid && !window.__mmdInitDone__) {
        try {
          window.mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
          window.__mmdInitDone__ = true;
        } catch {}
      }
      try {
        mermaid.parse(graph);                       // точная проверка
      } catch (e1) {
        if ((e1.str || e1.message || "").includes("got 'PS'")) {
          const graph2 = graph.replace(/\[([^\]]*)\]/g, (m, inner) => {
            return "[" + inner.replace(/\(/g, "&#40;").replace(/\)/g, "&#41;") + "]";
          });
          // second attempt
          mermaid.parse(graph2);
          const { svg } = await mermaid.render(id, graph2);
          const div = document.createElement("div");
          div.innerHTML = svg;
          pre.replaceWith(div);
          continue; // rendered via fallback, skip default path
        } else {
          throw e1;
        }
      }
      const { svg } = await mermaid.render(id, graph);
      const div = document.createElement("div");
      div.innerHTML = svg;
      pre.replaceWith(div);
    } catch (e) {
      const err = document.createElement("pre");
      err.style.color = "#c00";
      err.style.whiteSpace = "pre-wrap";
      const lines = graph.split("\n").map((l,i)=> String(i+1).padStart(3," ") + " │ " + l).join("\n");
      const baseMsg = `Ошибка Mermaid: ${e.str || e.message}`;
      const hint =
        /^\s*gantt\b/i.test(graph.trimStart())
          ? "\n\nПодсказка: в Gantt каждая задача обязана иметь параметры после двоеточия:  `Название : id, YYYY-MM-DD, 10d` или `: after otherId, 5d`."
          : "\n\nПодсказка: проверь «хвосты» после ] или ) и лишние символы на строках, а также закрывающие `end` для всех `subgraph`.";
      err.textContent = `${baseMsg}\n\n${lines}${hint}`;
      pre.replaceWith(err);
    }
  }
}

function renderVisualBlocks(root = document) {
  renderCharts(root);
  renderMermaid(root);
}

function insertHTMLAtCursor(html) {
  const ed = $("editor");
  ed.focus();
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    let range = sel.getRangeAt(0);
    range.deleteContents();
    const el = document.createElement("div");
    el.innerHTML = html;
    const frag = document.createDocumentFragment();
    let node, last;
    while ((node = el.firstChild)) {
      last = frag.appendChild(node);
    }
    range.insertNode(frag);
    if (last) {
      range = range.cloneRange();
      range.setStartAfter(last);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } else {
    ed.innerHTML += html;
  }
}
function md(html) {
  const raw = marked.parse(html || "");
  return window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
}
function addPageBreak() {
  insertHTMLAtCursor('<div class="page-break"></div>');
}

/* ---------- Auth ---------- */
async function login() {
  const u = $("username").value.trim(),
    p = $("password").value;
  try {
    const r = await apiFetch(BASE + "/auth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    if (!r.ok) throw new Error("Неверный логин/пароль");
    const d = await r.json();
    token = d.access;
    saveTokens({ access: d.access, refresh: d.refresh, user: u });
    token = d.access;
    $("login").style.display = "none";
    $("app").style.display = "block";
    $("who") && ($("who").textContent = u);
    await loadDocs();
    applyDocHash();
    const has = document.querySelectorAll("#docsList .item").length > 0;
    if (!has) await newDoc();
  } catch (e) {
    $("loginError").textContent = e.message;
  }
}

function insertAIAsHTML() {
  const text = $("aiOutput").textContent.trim();
  if (!text) return;
  const html =
    typeof marked !== "undefined" ? marked.parse(text) : md(text);
  insertHTMLAtCursor(html);
  renderVisualBlocks($("editor"));
}

/* ---------- Docs ---------- */
async function loadDocs() {
  const r = await apiFetch(BASE + "/documents/");
  const docs = await r.json();
  const list = $("docsList");
  if (!list) return;
  list.innerHTML = "";
  docs.forEach((doc) => {
    const a = document.createElement("a");
    a.className = "item";
    a.textContent = doc.title;
    a.href = getDocURL(doc.id);
    a.onclick = (e) => {
      e.preventDefault();
      openDoc(doc);
    };
    list.appendChild(a);
  });
}
function openDoc(doc) {
  currentDoc = doc;
  $("docName").value = doc.title || "Без названия";
  $("editor").innerHTML = doc.content_html || "";
  location.hash = `doc=${doc.id}`;
  renderVisualBlocks($("editor"));
}
async function newDoc() {
  const r = await apiFetch(BASE + "/documents/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Без названия", content_html: "" }),
  });
  const doc = await r.json();
  openDoc(doc);
  loadDocs();
}
async function saveDoc() {
  if (!currentDoc) return;
  const title = $("docName").value || "Без названия";
  const html = $("editor").innerHTML;
  const r = await apiFetch(`${BASE}/documents/${currentDoc.id}/`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, content_html: html }),
  });
  const doc = await r.json();
  openDoc(doc);
  loadDocs();
}
async function deleteDoc() {
  if (!currentDoc) return;
  if (!confirm("Удалить документ?")) return;
  await apiFetch(`${BASE}/documents/${currentDoc.id}/`, { method: "DELETE" });
  currentDoc = null;
  $("docName").value = "";
  $("editor").innerHTML = "";
  loadDocs();
}

function cmd(name, btn) {
  document.execCommand(name, false, null);
  if (btn) btn.classList.toggle("active");
  $("editor").focus();
}
function applyBlock(tag) {
  const val =
    tag === "P"
      ? "<p>"
      : tag === "PRE"
      ? "<pre>"
      : `<${tag.toLowerCase()}>`;
  document.execCommand("formatBlock", false, val);
  $("editor").focus();
}
function makeLink() {
  const url = prompt("Вставьте URL:", "https://");
  if (!url) return;
  document.execCommand("createLink", false, url);
  $("editor").focus();
}

/* ---------- AI (simple) ---------- */
async function runAI() {
  const prompt = $("prompt").value.trim();
  const content = $("editor").innerHTML;
  const out = $("aiOutput"),
    prev = $("aiPreview");
  out.textContent = "…";
  if (prev) prev.innerHTML = "";
  const resp = await apiFetch(BASE + "/ai/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "generate", prompt, html: content }),
  });
  const data = await resp.json();
  const text = pickContent(data) || "";
  out.textContent = text || "⚠️ Нет ответа";
  const html = md(text);
  if (prev) prev.innerHTML = html;
  insertHTMLAtCursor(html);
  renderVisualBlocks($("editor"));
}

function clearAI() {
  $("aiOutput").textContent = "";
  $("aiPreview").innerHTML = "";
  $("aiReason").textContent = "";
}

/* ---------- Export ---------- */
function getDocName(ext) {
  const base =
    ($("docName")?.value || "document")
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "_") || "document";
  return `${base}.${ext}`;
}

async function exportPDF() {
  window.scrollTo(0, 0);
  const page = document.querySelector(".page");
  if (!page) return;
  const filename = getDocName("pdf");
  page.style.wordBreak = "break-word";
  page.style.overflowWrap = "anywhere";
  const opt = {
    margin: [0, 0, 0, 0],
    filename,
    image: { type: "jpeg", quality: 0.98 },
    html2canvas: {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
      letterRendering: true,
      removeContainer: true,
    },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    pagebreak: {
      mode: ["css", "legacy"],
      avoid: ["table", "thead", "tr", "td", ".no-split"],
    },
  };
  await html2pdf().set(opt).from(page).save();
}

function exportDOCX() {
  const page = document.querySelector(".page");
  if (!page) return;
  const filename = getDocName("docx");
  let inner = page.innerHTML;
  inner = inner.replace(
    /<div class="page-break[^>]*><\/div>/g,
    '<br style="page-break-before: always">'
  );
  const docxCss = `@page { size: A4; margin: 20mm; }
    body { font-family: Arial, sans-serif; font-size: 12pt; color: #111; }
    h1{font-size:24pt;margin:0 0 10pt;} h2{font-size:18pt;margin:12pt 0 6pt;} h3{font-size:14pt;margin:10pt 0 6pt;}
    p{margin:6pt 0;} ul,ol{margin:6pt 0 6pt 18pt;}
    table{border-collapse:collapse;width:100%;table-layout:fixed;}
    th,td{border:1px solid #ddd;padding:6pt;vertical-align:top;word-break:break-word;}
    thead{display:table-header-group;} tr,td,th{page-break-inside:avoid;} code,pre{font-family:Consolas,'Courier New',monospace;}`;
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    docxCss +
    "</style></head><body>" +
    inner +
    "</body></html>";
  const blob = window.htmlDocx.asBlob(html, {
    orientation: "portrait",
    margins: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
  });
  saveAs(blob, filename);
}

/* ---------- Пагинация-превью ---------- */
const PAGE_W_MM = 210,
  PAGE_H_MM = 297,
  MARGIN_MM = 20,
  MM_TO_PX = 96 / 25.4;
const CONTENT_H_PX = (PAGE_H_MM - MARGIN_MM * 2) * MM_TO_PX;
let pagedMode = false,
  debounceTimer = null;

function togglePaged() {
  pagedMode = !pagedMode;
  $("togglePaged").classList.toggle("active", pagedMode);
  $("refreshPaged").style.display = pagedMode ? "" : "none";
  $("pagesPreview").style.display = pagedMode ? "" : "none";
  document.querySelector(".page").style.display = pagedMode ? "none" : "";
  if (pagedMode) renderPages();
}

function renderPages() {
  const src = $("editor"),
    out = $("pagesPreview");
  if (!src || !out) return;
  out.innerHTML = "";
  const meas = document.createElement("div");
  meas.style.cssText = `position:absolute; left:-99999px; top:-99999px; width:${
    PAGE_W_MM * MM_TO_PX
  }px; visibility:hidden; pointer-events:none;`;
  document.body.appendChild(meas);

  const newPage = () => {
    const p = document.createElement("div");
    p.className = "page";
    const body = document.createElement("div");
    body.className = "page-body";
    p.appendChild(body);
    out.appendChild(p);
    return body;
  };

  let pageBody = newPage();
  const fits = (container) =>
    container.getBoundingClientRect().height <= CONTENT_H_PX + 0.5;
  const nodes = Array.from(src.childNodes).map((n) => n.cloneNode(true));

  for (let node of nodes) {
    if (node.nodeType === 3 && !node.textContent.trim()) continue;

    if (node.nodeType === 1 && node.tagName === "TABLE") {
      const origTable = node;
      const thead =
        origTable.querySelector("thead")?.cloneNode(true) || null;
      const rows = Array.from(
        origTable.querySelectorAll("tbody tr, > tr")
      );
      const makeTable = () => {
        const tbl = document.createElement("table");
        tbl.style.width = "100%";
        tbl.style.borderCollapse = "collapse";
        if (thead) {
          const tHead = document.createElement("thead");
          tHead.appendChild(thead.cloneNode(true));
          tbl.appendChild(tHead);
        }
        const tBody = document.createElement("tbody");
        tbl.appendChild(tBody);
        pageBody.appendChild(tbl);
        return tBody;
      };
      let tBody = makeTable();
      for (const row of rows) {
        tBody.appendChild(row.cloneNode(true));
        meas.innerHTML = "";
        const test = pageBody.cloneNode(true);
        meas.appendChild(test);
        if (!fits(test)) {
          tBody.removeChild(tBody.lastChild);
          pageBody = newPage();
          tBody = makeTable();
          tBody.appendChild(row.cloneNode(true));
        }
      }
      continue;
    }

    pageBody.appendChild(node.cloneNode(true));
    meas.innerHTML = "";
    const test = pageBody.cloneNode(true);
    meas.appendChild(test);
    if (!fits(test)) {
      pageBody.removeChild(pageBody.lastChild);
      pageBody = newPage();
      pageBody.appendChild(node.cloneNode(true));
    }
  }
  renderVisualBlocks($("pagesPreview"));
  meas.remove();
}

document.addEventListener("input", () => {
  if (!pagedMode) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(renderPages, 300);
});

const _exportPDF_orig = exportPDF;
const _exportDOCX_orig = exportDOCX;
window.exportPDF = async function () {
  if (pagedMode) {
    const cont = $("pagesPreview");
    const filename = getDocName("pdf");
    const opt = {
      margin: [0, 0, 0, 0],
      filename,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
      },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: { mode: ["css", "legacy"] },
    };
    await html2pdf().set(opt).from(cont).save();
  } else {
    await _exportPDF_orig();
  }
};
window.exportDOCX = function () {
  if (pagedMode) {
    const cont = $("pagesPreview");
    const filename = getDocName("docx");
    const parts = Array.from(cont.querySelectorAll(".page-body")).map(
      (b) => b.innerHTML
    );
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:20mm;} body{font-family:Arial,sans-serif;font-size:12pt;color:#111;} table{border-collapse:collapse;width:100%;table-layout:fixed;} th,td{border:1px solid #ddd;padding:6pt;vertical-align:top;word-break:break-word;} thead{display:table-header-group;} tr,td,th{page-break-inside:avoid;}</style></head><body>' +
      parts
        .map(
          (x, i) =>
            (i ? '<br style="page-break-before: always">' : "") + x
        )
        .join("") +
      "</body></html>";
    const blob = window.htmlDocx.asBlob(html, {
      orientation: "portrait",
      margins: { top: 1134, right: 1134, bottom: 1134, left: 1134 },
    });
    saveAs(blob, filename);
  } else {
    _exportDOCX_orig();
  }
};

/* ---------- Deep link ---------- */
function getDocURL(id) {
  const url = new URL(window.location.href);
  url.hash = `doc=${id}`;
  return url.toString();
}
async function openDocById(id) {
  try {
    const r = await apiFetch(`${BASE}/documents/${id}/`);
    if (!r.ok) return;
    const doc = await r.json();
    openDoc(doc);
  } catch {}
}
function applyDocHash() {
  const m = location.hash.match(/doc=([\w-]+)/);
  if (m && token) {
    openDocById(m[1]);
  }
}
function copyDocLink() {
  if (!currentDoc?.id) {
    return alert("Документ ещё не выбран/создан");
  }
  const link = getDocURL(currentDoc.id);
  navigator.clipboard
    .writeText(link)
    .then(() => alert("Ссылка скопирована:\n" + link))
    .catch(() => prompt("Скопируйте ссылку вручную:", link));
}
document.addEventListener("DOMContentLoaded", async () => {
  ensureLoaderDom();
  const acc = await getValidAccessToken();
  if (acc){
    token = acc;
    const u = localStorage.getItem(LS_KEYS.user) || "";
    try{
      $("who") && ($("who").textContent = u);
      $("login").style.display = "none";
      $("app").style.display = "block";
    }catch{}
    await loadDocs();
    applyDocHash();
  } else {
    try{
      $("login").style.display = "block";
      $("app").style.display = "none";
    }catch{}
  }
});

function logout(){
  clearTokens();
  currentDoc = null;
  $("docName").value = "";
  $("editor").innerHTML = "";
  $("app").style.display = "none";
  $("login").style.display = "block";
}