/* ============================================================
   TextMD — Editor y organizador local de documentos Markdown
   Vanilla JS · localStorage · Marked.js + DOMPurify
   ============================================================ */
'use strict';

/* ---------- Claves de almacenamiento ---------- */
const LS_PROJECTS = 'textmd_projects';
const LS_DOCUMENTS = 'textmd_documents';
const LS_TRASH = 'textmd_trash';
const LS_PREFS = 'textmd_preferences';

/* ---------- Utilidades ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function uuid() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
const nowISO = () => new Date().toISOString();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'ahora mismo';
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'ayer';
  if (d < 30) return `hace ${d} días`;
  return new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return ''; }
}
function excerpt(md, n = 90) {
  const t = String(md || '').replace(/[#>*`~\-+[\]!()_]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}
function countWords(t) {
  const w = String(t || '').trim().split(/\s+/).filter(Boolean);
  return w.length === 1 && w[0] === '' ? 0 : (String(t || '').trim() === '' ? 0 : w.length);
}
function refreshIcons() { if (window.lucide) lucide.createIcons(); }

/* ---------- Persistencia centralizada ---------- */
function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (e) { toast('No se pudo guardar (almacenamiento lleno o bloqueado)'); }
}

function loadProjects() {
  const v = readJSON(LS_PROJECTS, []);
  return Array.isArray(v) ? v : [];
}
function saveProjects(projects) { writeJSON(LS_PROJECTS, projects); }

function loadDocuments() {
  const v = readJSON(LS_DOCUMENTS, []);
  return Array.isArray(v) ? v : [];
}
function saveDocuments(documents) { writeJSON(LS_DOCUMENTS, documents); }

function loadTrash() {
  const v = readJSON(LS_TRASH, { projects: [], documents: [] });
  if (!v || typeof v !== 'object') return { projects: [], documents: [] };
  return { projects: Array.isArray(v.projects) ? v.projects : [], documents: Array.isArray(v.documents) ? v.documents : [] };
}
function saveTrash(trash) { writeJSON(LS_TRASH, trash); }

function loadPreferences() {
  const v = readJSON(LS_PREFS, {});
  return Object.assign({ sidebarCollapsed: false, viewMode: 'split', lastProjectId: null, lastDocumentId: null, theme: 'light', readFontSize: 17, tocOpen: false }, v || {});
}
function savePreferences(prefs) { writeJSON(LS_PREFS, prefs); }

/* ---------- Estado ---------- */
let projects = loadProjects();
let documents = loadDocuments();
let trash = loadTrash();
let prefs = loadPreferences();

let selectedProjectId = prefs.lastProjectId;
let selectedDocumentId = prefs.lastDocumentId;
let currentRoute = 'project'; // 'project' | 'editor' | 'trash' | 'welcome'
let viewMode = prefs.viewMode || 'split';
let saveTimer = null;
let searchIndex = -1;
let previewQueued = false;
let lastEditorDocId = null;
let navHist = [];
let navHi = -1;

function persistPrefs() {
  prefs.lastProjectId = selectedProjectId;
  prefs.lastDocumentId = selectedDocumentId;
  prefs.viewMode = viewMode;
  savePreferences(prefs);
}

/* ---------- Tema oscuro / claro ---------- */
function applyTheme() {
  const dark = prefs.theme === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  const btn = $('#btnTheme');
  if (btn) btn.innerHTML = `<i data-lucide="${dark ? 'sun' : 'moon'}" class="w-4 h-4"></i>`;
  refreshIcons();
}
function toggleTheme() {
  prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
  savePreferences(prefs);
  applyTheme();
  toast(prefs.theme === 'dark' ? 'Modo oscuro activado' : 'Modo claro activado', prefs.theme === 'dark' ? 'moon' : 'sun');
}

/* ---------- Copiado ultrarrápido ---------- */
async function copyText(text, label) {
  const t = String(text ?? '');
  if (!t) { toast('Nada que copiar', 'info'); return false; }
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    // Fallback síncrono (iframes / permisos denegados)
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* noop */ }
    ta.remove();
  }
  toast(label || 'Copiado al portapapeles', 'clipboard-check');
  return true;
}
function currentMarkdown() {
  const d = currentDoc();
  if (!d) return '';
  // Si el editor está abierto, copiar lo que se ve (incluye cambios sin debounce)
  const ta = $('#editor');
  if (currentRoute === 'editor' && ta && document.activeElement !== null) {
    const title = $('#docTitle')?.value?.trim();
    const body = ta.value;
    void title;
    return body;
  }
  return d.content || '';
}
function copyCurrentMarkdown() { return copyText(currentMarkdown(), 'Markdown copiado'); }
function copyCurrentHTML() {
  const md = currentMarkdown();
  if (!md.trim()) { toast('Nada que copiar', 'info'); return; }
  let html = '';
  try { html = DOMPurify.sanitize(marked.parse(md)); } catch { html = ''; }
  copyText(html, 'HTML copiado');
}

/* ---------- Índice opcional (TOC) ---------- */
let tocItems = [];      // [{ level, text, line }]
let tocSig = '';
let tocSpyQueued = false;
const normToc = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/* Extrae títulos ATX (# ...) con nº de línea, ignorando bloques de código cercados */
function parseHeadings(md) {
  const out = [];
  const lines = String(md || '').split('\n');
  let fence = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (/^(`{3,}|~{3,})/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.replace(/^>\s?/, ''));
    if (m) {
      const text = m[2].replace(/[*_`~[\]()!]/g, '').trim();
      if (text) out.push({ level: m[1].length, text, line: i });
    }
  });
  return out;
}

function toggleToc(force) {
  prefs.tocOpen = typeof force === 'boolean' ? force : !prefs.tocOpen;
  savePreferences(prefs);
  applyTocVisibility();
  if (prefs.tocOpen) buildToc();
}

function applyTocVisibility() {
  const show = !!prefs.tocOpen && currentRoute === 'editor' && !!currentDoc();
  $('#tocPanel').classList.toggle('hidden', !show);
  const btn = $('#btnToc');
  if (btn) {
    btn.style.display = currentRoute === 'editor' && currentDoc() ? '' : 'none';
    btn.classList.toggle('on', show);
    btn.title = show ? 'Ocultar índice' : 'Mostrar índice (opcional)';
  }
  const showRead = !!prefs.tocOpen && !$('#readOverlay').classList.contains('hidden');
  $('#readToc').classList.toggle('hidden', !showRead);
  refreshIcons();
}

/* Construye el índice (solo si cambió la firma: barato para docs de 100 hojas) */
function buildToc() {
  const d = currentDoc();
  const md = currentRoute === 'editor' && $('#editor') ? $('#editor').value : (d?.content || '');
  const items = parseHeadings(md);
  const sig = items.map((h) => h.level + ':' + h.text).join('|');
  tocItems = items;
  if (sig !== tocSig) {
    tocSig = sig;
    paintTocList($('#tocList'), items, (h, i) => tocJump(i));
    $('#tocCount').textContent = items.length ? `${items.length}` : '';
  }
  if (!$('#readOverlay').classList.contains('hidden')) {
    paintTocList($('#readTocList'), items, (h, i) => tocJumpRead(i));
  }
  updateTocSpy();
}

function paintTocList(nav, items, onJump) {
  if (!nav) return;
  nav.innerHTML = '';
  if (!items.length) {
    nav.innerHTML = `<p class="text-[12px] text-ink-400 px-2 py-2">Sin títulos todavía.<br/>Usa <code class="font-mono"># Título</code> para crear secciones.</p>`;
    return;
  }
  items.forEach((h, i) => {
    const b = document.createElement('button');
    b.className = `toc-item toc-l${h.level}`;
    b.textContent = h.text;
    b.title = h.text;
    b.dataset.idx = i;
    b.onclick = () => onJump(h, i);
    nav.appendChild(b);
  });
}

/* Asocia cada item con su encabezado real del DOM (tolera setext/citas) */
function domHeadsFor(container, items) {
  const els = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  els.forEach((el, i) => { if (!el.id) el.id = 'tmd-h-' + i; });
  if (!items.length) return [];
  if (els.length === items.length) return els;
  const byText = {};
  els.forEach((el) => {
    const k = normToc(el.textContent);
    (byText[k] = byText[k] || []).push(el);
  });
  return items.map((h, i) => {
    const q = byText[normToc(h.text)];
    if (q && q.length) return q.shift();
    return els[Math.min(i, els.length - 1)] || null;
  });
}

function flashEl(el) {
  if (!el) return;
  el.classList.remove('toc-flash');
  void el.offsetWidth;
  el.classList.add('toc-flash');
  setTimeout(() => el.classList.remove('toc-flash'), 1200);
}

function previewVisible() {
  return currentRoute === 'editor' && viewMode !== 'edit' && !$('#panePreview').classList.contains('hidden');
}

/* Salto desde el índice del editor: scroll en preview o cursor en modo edición */
function editorLineOffset(ta, line) {
  const lines = ta.value.split('\n');
  let off = 0;
  for (let l = 0; l < Math.min(line, lines.length); l++) off += lines[l].length + 1;
  return off;
}
function jumpEditorToLine(line) {
  const ta = $('#editor');
  if (!ta) return;
  const off = editorLineOffset(ta, line);
  try { ta.focus({ preventScroll: true }); } catch { ta.focus(); }
  ta.setSelectionRange(off, off);
  ta.scrollTop = Math.max(0, line * 28 - 140);
}
/* Salto desde el índice: el EDITOR siempre acompaña + la preview si está visible */
function tocJump(i) {
  const h = tocItems[i];
  if (!h) return;
  jumpEditorToLine(h.line);
  if (previewVisible()) {
    const els = domHeadsFor($('#preview'), tocItems);
    const el = els[i];
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); flashEl(el); }
  }
  setTocActive(i);
}

function tocJumpRead(i) {
  const els = domHeadsFor($('#readArticle'), tocItems);
  const el = els[i];
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); flashEl(el); }
  setTocActive(i, true);
}

function setTocActive(i, isRead = false) {
  $$('#tocList .toc-item').forEach((b) => b.classList.toggle('active', !isRead && Number(b.dataset.idx) === i));
  $$('#readTocList .toc-item').forEach((b) => b.classList.toggle('active', isRead && Number(b.dataset.idx) === i));
}

/* Scrollspy barato (rAF) sobre el panel de preview */
function updateTocSpy() {
  if (!prefs.tocOpen || !previewVisible() || !tocItems.length) return;
  const pane = $('#panePreview');
  const els = domHeadsFor($('#preview'), tocItems);
  let active = 0;
  els.forEach((el, i) => {
    if (el && (el.offsetTop - pane.scrollTop) < 120) active = i;
  });
  setTocActive(active);
}
function queueTocSpy() {
  if (tocSpyQueued) return;
  tocSpyQueued = true;
  requestAnimationFrame(() => { tocSpyQueued = false; updateTocSpy(); });
}

/* Seed de ejemplo solo si está totalmente vacío (y sin papelera) */
(function seed() {
  if (projects.length === 0 && documents.length === 0 && trash.projects.length === 0 && trash.documents.length === 0) {
    const p1 = { id: uuid(), name: 'Proyecto de Grado', createdAt: nowISO(), updatedAt: nowISO() };
    const p2 = { id: uuid(), name: 'Personal', createdAt: nowISO(), updatedAt: nowISO() };
    projects = [p1, p2];
    documents = [{
      id: uuid(), projectId: p1.id, title: 'Bienvenida',
      content: '# Bienvenido a TextMD\n\nOrganiza tus **proyectos** y escribe documentos *Markdown*.\n\n## Qué puedes hacer\n\n- Crear proyectos y documentos\n- Editar con **vista previa** en vivo\n- Todo se guarda automáticamente en `localStorage`\n\n> Todo es local: sin cuentas, sin servidor.\n\n```js\nconsole.log("Hola TextMD");\n```\n',
      createdAt: nowISO(), updatedAt: nowISO(),
    }];
    selectedProjectId = p1.id;
    saveProjects(projects); saveDocuments(documents);
  }
})();

if (selectedProjectId && !projects.find((p) => p.id === selectedProjectId)) selectedProjectId = null;
if (!selectedProjectId && projects.length) selectedProjectId = projects[0].id;
if (selectedDocumentId && !documents.find((d) => d.id === selectedDocumentId)) selectedDocumentId = null;

/* ---------- Toasts ---------- */
function toast(msg, icon = 'check') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4"></i><span>${esc(msg)}</span>`;
  box.appendChild(el);
  refreshIcons();
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, 2200);
}

/* ---------- Modal genérico ---------- */
let modalResolve = null;
function openModal({ title, desc = '', placeholder = '', value = '', showInput = false, okText = 'Guardar', okDanger = false, cancelText = 'Cancelar' }) {
  $('#modalTitle').textContent = title;
  $('#modalDesc').textContent = desc;
  const input = $('#modalInput');
  input.classList.toggle('hidden', !showInput);
  input.placeholder = placeholder;
  input.value = value || '';
  const actions = $('#modalActions');
  actions.innerHTML = '';
  const btnCancel = document.createElement('button');
  btnCancel.className = 'btn-secondary'; btnCancel.textContent = cancelText;
  const btnOk = document.createElement('button');
  btnOk.className = okDanger ? 'btn-danger' : 'btn-primary';
  btnOk.style.padding = '8px 14px'; btnOk.style.fontSize = '13px'; btnOk.style.borderRadius = '8px';
  btnOk.textContent = okText;
  actions.append(btnCancel, btnOk);
  const ov = $('#modalOverlay');
  ov.classList.remove('hidden'); ov.classList.add('flex');
  refreshIcons();
  if (showInput) setTimeout(() => { input.focus(); input.select(); }, 50);
  return new Promise((resolve) => {
    modalResolve = resolve;
    const close = (val) => { ov.classList.add('hidden'); ov.classList.remove('flex'); modalResolve = null; resolve(val); };
    btnCancel.onclick = () => close(null);
    btnOk.onclick = () => close(showInput ? input.value.trim() : true);
    input.onkeydown = (e) => { if (e.key === 'Enter') btnOk.click(); if (e.key === 'Escape') close(null); };
    ov.onmousedown = (e) => { if (e.target === ov) close(null); };
    btnOk.focus;
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalResolve === undefined) { /* noop */ }
});

/* ---------- CRUD: Proyectos ---------- */
function createProject(name) {
  const p = { id: uuid(), name: name.trim(), createdAt: nowISO(), updatedAt: nowISO() };
  projects.push(p);
  saveProjects(projects);
  selectedProjectId = p.id; selectedDocumentId = null; currentRoute = 'project';
  persistPrefs(); render();
  toast('Proyecto creado', 'folder-plus');
  return p;
}
function renameProject(id, name) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  p.name = name.trim() || p.name;
  p.updatedAt = nowISO();
  saveProjects(projects); render();
  toast('Proyecto renombrado');
}
function deleteProject(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  const docs = documents.filter((d) => d.projectId === id);
  trash.projects.push({ ...p, deletedAt: nowISO() });
  docs.forEach((d) => trash.documents.push({ ...d, deletedAt: nowISO(), projectName: p.name }));
  saveTrash(trash);
  projects = projects.filter((x) => x.id !== id);
  documents = documents.filter((d) => d.projectId !== id);
  saveProjects(projects); saveDocuments(documents);
  if (selectedProjectId === id) { selectedProjectId = projects[0]?.id || null; selectedDocumentId = null; }
  currentRoute = selectedProjectId ? 'project' : 'welcome';
  persistPrefs(); render();
  toast('Proyecto movido a la papelera', 'trash-2');
}

/* ---------- CRUD: Documentos ---------- */
function createDocument(projectId, title = 'Sin título') {
  const pid = projectId || selectedProjectId;
  if (!pid) return null;
  const d = { id: uuid(), projectId: pid, title: title.trim() || 'Sin título', content: '', createdAt: nowISO(), updatedAt: nowISO() };
  documents.push(d);
  saveDocuments(documents);
  const p = projects.find((x) => x.id === pid);
  if (p) { p.updatedAt = nowISO(); saveProjects(projects); }
  openDocument(d.id);
  toast('Documento creado', 'file-plus');
  return d;
}
function openDocument(id) {
  selectedDocumentId = id;
  const d = documents.find((x) => x.id === id);
  if (d) selectedProjectId = d.projectId;
  currentRoute = 'editor';
  persistPrefs(); render();
  closeDrawer();
  resetEditorScroll();
  setTimeout(() => $('#editor')?.focus(), 60);
}
/* Lleva cursor al inicio y ambas vistas arriba (abrir / cambiar de documento) */
function resetEditorScroll() {
  const ta = $('#editor');
  if (ta) { ta.scrollTop = 0; try { ta.setSelectionRange(0, 0); } catch { /* noop */ } }
  const pp = $('#panePreview');
  if (pp) pp.scrollTop = 0;
}
function saveDocContent(id, content, title) {
  const d = documents.find((x) => x.id === id);
  if (!d) return;
  if (typeof content === 'string') d.content = content;
  if (typeof title === 'string') d.title = title.trim() || 'Sin título';
  d.updatedAt = nowISO();
  saveDocuments(documents);
  const p = projects.find((x) => x.id === d.projectId);
  if (p) { p.updatedAt = nowISO(); saveProjects(projects); }
}
function renameDocument(id, title) {
  const d = documents.find((x) => x.id === id);
  if (!d) return;
  d.title = title.trim() || 'Sin título';
  d.updatedAt = nowISO();
  saveDocuments(documents); render();
  toast('Documento renombrado');
}
function duplicateDocument(id) {
  const d = documents.find((x) => x.id === id);
  if (!d) return;
  const copy = { ...d, id: uuid(), title: `${d.title} (copia)`, createdAt: nowISO(), updatedAt: nowISO() };
  documents.push(copy);
  saveDocuments(documents); render();
  toast('Documento duplicado', 'copy');
}
function deleteDocument(id) {
  const d = documents.find((x) => x.id === id);
  if (!d) return;
  const p = projects.find((x) => x.id === d.projectId);
  trash.documents.push({ ...d, deletedAt: nowISO(), projectName: p?.name || '—' });
  saveTrash(trash);
  documents = documents.filter((x) => x.id !== id);
  saveDocuments(documents);
  if (selectedDocumentId === id) { selectedDocumentId = null; currentRoute = 'project'; }
  persistPrefs(); render();
  toast('Documento movido a la papelera', 'trash-2');
}

/* ---------- Papelera ---------- */
function restoreTrashItem(kind, id) {
  if (kind === 'doc') {
    const i = trash.documents.findIndex((d) => d.id === id);
    if (i < 0) return;
    const [d] = trash.documents.splice(i, 1);
    if (!projects.find((p) => p.id === d.projectId)) {
      // el proyecto ya no existe: crear uno de recuperación
      const np = { id: d.projectId, name: d.projectName || 'Recuperados', createdAt: nowISO(), updatedAt: nowISO() };
      projects.push(np); saveProjects(projects);
    }
    const { deletedAt, projectName, ...doc } = d;
    documents.push(doc); saveDocuments(documents); saveTrash(trash);
    toast('Documento restaurado', 'archive-restore');
  } else {
    const i = trash.projects.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [p] = trash.projects.splice(i, 1);
    const { deletedAt, ...proj } = p;
    projects.push(proj);
    const docs = trash.documents.filter((d) => d.projectId === id);
    trash.documents = trash.documents.filter((d) => d.projectId !== id);
    docs.forEach((d) => { const { deletedAt: _a, projectName: _b, ...doc } = d; documents.push(doc); });
    saveProjects(projects); saveDocuments(documents); saveTrash(trash);
    if (!selectedProjectId) selectedProjectId = id;
    toast('Proyecto restaurado', 'archive-restore');
  }
  persistPrefs(); render();
}
function destroyTrashItem(kind, id) {
  if (kind === 'doc') trash.documents = trash.documents.filter((d) => d.id !== id);
  else { trash.projects = trash.projects.filter((p) => p.id !== id); trash.documents = trash.documents.filter((d) => d.projectId !== id); }
  saveTrash(trash); render();
  toast('Eliminado definitivamente', 'trash');
}
function emptyTrash() {
  trash = { projects: [], documents: [] };
  saveTrash(trash); render();
  toast('Papelera vaciada', 'trash');
}

/* ---------- Acciones con confirmación ---------- */
async function askNewProject() {
  const name = await openModal({ title: 'Nuevo proyecto', desc: 'Dale un nombre a tu proyecto.', placeholder: 'Ej. Proyecto de Grado', showInput: true, okText: 'Crear proyecto' });
  if (name) createProject(name);
}
async function askRenameProject(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  const name = await openModal({ title: 'Renombrar proyecto', desc: 'Escribe el nuevo nombre.', value: p.name, showInput: true, okText: 'Renombrar' });
  if (name) renameProject(id, name);
}
async function askDeleteProject(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  const n = documents.filter((d) => d.projectId === id).length;
  const ok = await openModal({
    title: `¿Eliminar el proyecto "${p.name}"?`,
    desc: `Esta acción moverá el proyecto y sus ${n} documento(s) a la papelera. Podrás restaurarlos después.`,
    okText: 'Mover a la papelera', okDanger: true,
  });
  if (ok) deleteProject(id);
}
async function askRenameDocument(id) {
  const d = documents.find((x) => x.id === id);
  if (!d) return;
  const title = await openModal({ title: 'Renombrar documento', desc: 'Escribe el nuevo nombre (sin .md).', value: d.title === 'Sin título' ? '' : d.title, placeholder: 'Sin título', showInput: true, okText: 'Renombrar' });
  if (title !== null) renameDocument(id, title || 'Sin título');
}
async function askDeleteDocument(id) {
  const d = documents.find((x) => x.id === id);
  if (!d) return;
  const ok = await openModal({
    title: `¿Eliminar "${d.title || 'Sin título'}"?`,
    desc: 'El documento se moverá a la papelera y podrás restaurarlo después.',
    okText: 'Mover a la papelera', okDanger: true,
  });
  if (ok) deleteDocument(id);
}

/* ============================================================
   RENDER
   ============================================================ */
function projectDocs(pid) {
  return documents.filter((d) => d.projectId === pid).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}
const currentProject = () => projects.find((p) => p.id === selectedProjectId) || null;
const currentDoc = () => documents.find((d) => d.id === selectedDocumentId) || null;

function render() {
  renderSidebar();
  renderBreadcrumb();
  renderMenu();
  $('#viewSwitcher').classList.toggle('hidden', currentRoute !== 'editor');
  $('#viewSwitcher').classList.toggle('flex', currentRoute !== 'editor' ? false : true);
  $$('#viewSwitcher .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === viewMode));
  ['projectView', 'editorView', 'trashView', 'welcomeView'].forEach((id) => {
    const el = document.getElementById(id);
    el.classList.add('hidden'); el.classList.remove('flex');
  });
  if (currentRoute === 'trash') { $('#trashView').classList.remove('hidden'); renderTrash(); }
  else if (currentRoute === 'editor' && currentDoc()) { $('#editorView').classList.remove('hidden'); $('#editorView').classList.add('flex'); renderEditor(); }
  else if (projects.length === 0) { currentRoute = 'welcome'; $('#welcomeView').classList.remove('hidden'); }
  else {
    if (!currentProject()) { selectedProjectId = projects[0].id; }
    if (currentRoute === 'editor' && !currentDoc()) currentRoute = 'project';
    if (currentRoute !== 'editor') { currentRoute = 'project'; $('#projectView').classList.remove('hidden'); renderProjectView(); }
    else { $('#editorView').classList.remove('hidden'); $('#editorView').classList.add('flex'); renderEditor(); }
  }
  // sidebar colapsada (en móvil siempre drawer, no rail)
  const isMobile = window.matchMedia('(max-width: 767px)').matches;
  const collapsed = isMobile ? false : prefs.sidebarCollapsed;
  $('#sidebar').classList.toggle('hidden', collapsed && !isMobile);
  $('#rail').classList.toggle('hidden', !collapsed || isMobile);
  $('#rail').classList.toggle('flex', collapsed && !isMobile);
  // En móvil el sidebar se muestra como drawer con .open-mobile
  if (isMobile && !collapsed) $('#sidebar').classList.add('max-md:-translate-x-full');
  $('#fabNew').classList.toggle('hidden', currentRoute === 'welcome');
  $('#fabNew').classList.toggle('flex', currentRoute !== 'welcome');
  // Botones del topbar según contexto
  const hasDoc = !!(currentRoute === 'editor' && currentDoc());
  $('#btnRead').style.display = hasDoc ? '' : 'none';
  $('#btnCopyFast').style.display = hasDoc ? '' : 'none';
  applyTocVisibility();
  recordHistory();
  updateNavButtons();
  refreshIcons();
}

/* ---------- Historial atrás/adelante in-app ---------- */
function recordHistory() {
  const sig = currentRoute + '|' + (selectedProjectId || '') + '|' + (selectedDocumentId || '');
  if (navHist[navHi] === sig) return;
  navHist = navHist.slice(0, navHi + 1);
  navHist.push(sig);
  if (navHist.length > 100) navHist.shift();
  navHi = navHist.length - 1;
}
function goHist(delta) {
  const ni = navHi + delta;
  if (ni < 0 || ni >= navHist.length) return;
  navHi = ni;
  const [route, pid, did] = navHist[ni].split('|');
  currentRoute = route;
  selectedProjectId = pid || null;
  selectedDocumentId = did || null;
  if (selectedProjectId && !projects.find((p) => p.id === selectedProjectId)) selectedProjectId = projects[0]?.id || null;
  if (selectedDocumentId && !documents.find((d) => d.id === selectedDocumentId)) selectedDocumentId = null;
  if (currentRoute === 'editor' && !selectedDocumentId) currentRoute = selectedProjectId ? 'project' : 'welcome';
  if (currentRoute === 'project' && !selectedProjectId) currentRoute = 'welcome';
  persistPrefs(); render(); closeDrawer();
}
function updateNavButtons() {
  const b = $('#btnBack'), f = $('#btnFwd');
  if (b) b.disabled = navHi <= 0;
  if (f) f.disabled = navHi >= navHist.length - 1;
}

/* ---------- Drawer móvil ---------- */
function openDrawer() {
  $('#sidebar').classList.remove('max-md:-translate-x-full');
  $('#sidebar').classList.add('open-mobile');
  $('#sideBackdrop').classList.remove('hidden');
}
function closeDrawer() {
  $('#sidebar').classList.add('max-md:-translate-x-full');
  $('#sidebar').classList.remove('open-mobile');
  $('#sideBackdrop').classList.add('hidden');
}
function toggleDrawer() {
  if ($('#sidebar').classList.contains('open-mobile')) closeDrawer();
  else openDrawer();
}

/* ---------- Sidebar ---------- */
function renderSidebar() {
  const list = $('#projectList');
  $('#projectCount').textContent = projects.length ? `${projects.length}` : '';
  const trashN = trash.projects.length + trash.documents.length;
  const tc = $('#trashCount');
  tc.classList.toggle('hidden', trashN === 0);
  tc.textContent = trashN;

  if (!projects.length) {
    list.innerHTML = `<p class="text-[12.5px] text-ink-400 px-2 py-3">Aún no hay proyectos.<br/>Crea el primero para empezar.</p>`;
    return;
  }
  list.innerHTML = '';
  [...projects].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).forEach((p) => {
    const isSel = p.id === selectedProjectId;
    const docs = projectDocs(p.id);
    const wrap = document.createElement('div');
    wrap.className = 'rounded-md' + (isSel ? ' bg-[#f0efed]/70' : '');

    const row = document.createElement('div');
    row.className = 'group flex items-center gap-2 px-2 py-[7px] rounded-md cursor-pointer hover:bg-[#f0efed] ' + (isSel ? 'font-medium' : '');
    row.innerHTML = `
      <i data-lucide="folder" class="w-4 h-4 shrink-0 ${isSel ? 'text-ink-900' : 'text-ink-400'}"></i>
      <span class="text-[13px] truncate flex-1">${esc(p.name)}</span>
      <span class="text-[11px] text-ink-400">${docs.length || ''}</span>
      <button class="proj-menu opacity-0 group-hover:opacity-100 icon-btn !w-6 !h-6" title="Opciones"><i data-lucide="ellipsis" class="w-3.5 h-3.5 pointer-events-none"></i></button>`;
    row.onclick = (e) => {
      if (e.target.closest('.proj-menu')) return;
      selectedProjectId = p.id; selectedDocumentId = null; currentRoute = 'project';
      persistPrefs(); render(); closeDrawer();
    };
    row.querySelector('.proj-menu').onclick = (e) => {
      e.stopPropagation();
      projectContextMenu(p.id, e.currentTarget);
    };
    wrap.appendChild(row);

    if (isSel) {
      const sub = document.createElement('div');
      sub.className = 'ml-5 pl-2 border-l border-line/80 my-0.5 space-y-px pb-1';
      if (!docs.length) sub.innerHTML = `<p class="text-[12px] text-ink-400 px-2 py-1">Sin documentos</p>`;
      docs.slice(0, 30).forEach((d) => {
        const dr = document.createElement('div');
        dr.className = 'flex items-center gap-2 px-2 py-[5px] rounded-md cursor-pointer text-[12.5px] hover:bg-[#e9e8e6]/70 ' + (d.id === selectedDocumentId ? 'bg-white border border-line shadow-subtle font-medium' : 'text-ink-700 border border-transparent');
        dr.innerHTML = `<i data-lucide="file-text" class="w-3.5 h-3.5 shrink-0 text-ink-400"></i><span class="truncate flex-1">${esc(d.title || 'Sin título')}.md</span>`;
        dr.title = (d.title || 'Sin título') + '.md';
        dr.onclick = () => openDocument(d.id);
        sub.appendChild(dr);
      });
      const addBtn = document.createElement('button');
      addBtn.className = 'flex items-center gap-1.5 px-2 py-[5px] text-[12px] text-ink-400 hover:text-ink-900 rounded-md';
      addBtn.innerHTML = `<i data-lucide="plus" class="w-3.5 h-3.5"></i> Nuevo documento`;
      addBtn.onclick = () => createDocument(p.id);
      sub.appendChild(addBtn);
      wrap.appendChild(sub);
    }
    list.appendChild(wrap);
  });
}

function projectContextMenu(projectId, anchor) {
  closeAllPopups();
  const menu = document.createElement('div');
  menu.className = 'popup fixed z-50 w-52 bg-white border border-line rounded-lg shadow-pop py-1 text-[13px] fade-in';
  menu.innerHTML = `
    <button class="menu-item" data-a="open"><i data-lucide="folder-open" class="w-4 h-4"></i> Abrir</button>
    <button class="menu-item" data-a="newdoc"><i data-lucide="file-plus" class="w-4 h-4"></i> Nuevo documento</button>
    <button class="menu-item" data-a="rename"><i data-lucide="pen-line" class="w-4 h-4"></i> Renombrar</button>
    <div class="my-1 border-t border-line/70"></div>
    <button class="menu-item danger" data-a="delete"><i data-lucide="trash-2" class="w-4 h-4"></i> Eliminar</button>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = Math.min(r.bottom + 4, window.innerHeight - 200) + 'px';
  menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
  refreshIcons();
  menu.onclick = (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    closeAllPopups();
    if (a === 'open') { selectedProjectId = projectId; selectedDocumentId = null; currentRoute = 'project'; persistPrefs(); render(); }
    if (a === 'newdoc') { selectedProjectId = projectId; persistPrefs(); createDocument(projectId); }
    if (a === 'rename') askRenameProject(projectId);
    if (a === 'delete') askDeleteProject(projectId);
  };
  setTimeout(() => document.addEventListener('mousedown', closeAllPopupsOnce, { once: true }), 10);
}
function closeAllPopupsOnce(e) { if (!e.target.closest('.popup') && !e.target.closest('#menuDropdown')) closeAllPopups(); else setTimeout(() => document.addEventListener('mousedown', closeAllPopupsOnce, { once: true }), 10); }
function closeAllPopups() { $$('.popup').forEach((p) => p.remove()); $('#menuDropdown').classList.add('hidden'); }

/* ---------- Breadcrumb + menú ⋯ ---------- */
function renderBreadcrumb() {
  const bc = $('#breadcrumb');
  const p = currentProject();
  const d = currentDoc();
  if (currentRoute === 'trash') {
    bc.innerHTML = `<span class="flex items-center gap-1.5"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Papelera</span>`;
  } else if (currentRoute === 'editor' && d) {
    bc.innerHTML = `
      <button id="crumbProj" class="hover:text-ink-900 hover:underline truncate max-w-[110px] sm:max-w-[160px] shrink-0">${esc(p?.name || '—')}</button>
      <span class="text-ink-400 shrink-0">/</span>
      <i data-lucide="file-text" class="w-3.5 h-3.5 text-ink-400 shrink-0"></i>
      <input id="crumbTitle" type="text" value="${esc(d.title === 'Sin título' ? '' : (d.title || ''))}" placeholder="Sin título" autocomplete="off" spellcheck="false"
        class="bg-transparent text-ink-900 font-medium focus:outline-none rounded px-1 -ml-1 focus:bg-gray-100 max-w-[36vw] sm:max-w-[300px]" />
      <span class="text-ink-400 shrink-0 hidden sm:inline -ml-1">.md</span>`;
    $('#crumbProj').onclick = () => { currentRoute = 'project'; selectedDocumentId = null; persistPrefs(); render(); };
    const ct = $('#crumbTitle');
    sizeCrumb(ct);
    ct.oninput = () => { sizeCrumb(ct); $('#docTitle').value = ct.value; onTitleInput(); };
    ct.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('#editor')?.focus(); }
    };
    refreshIcons();
  } else if (p) {
    bc.innerHTML = `<span class="flex items-center gap-1.5 text-ink-900 font-medium"><i data-lucide="folder" class="w-3.5 h-3.5 text-ink-400"></i> ${esc(p.name)}</span>`;
  } else {
    bc.innerHTML = `<span>TextMD</span>`;
  }
}

/* Título editable del topbar: ancho dinámico + sincronía sin perder foco */
function sizeCrumb(el) {
  if (!el) return;
  const n = (el.value || el.placeholder || '').length;
  el.style.width = Math.min(Math.max(n + 1, 6), 40) + 'ch';
}
function syncCrumbTitle(d) {
  const ct = $('#crumbTitle');
  if (ct && document.activeElement !== ct) {
    ct.value = d.title === 'Sin título' ? '' : (d.title || '');
    sizeCrumb(ct);
  }
}

function renderMenu() {
  const dd = $('#menuDropdown');
  const p = currentProject();
  const d = currentDoc();
  let html = '';
  if (currentRoute === 'editor' && d) {
    html = `
      <button class="menu-item" data-a="read"><i data-lucide="book-open" class="w-4 h-4"></i> Modo lectura</button>
      <button class="menu-item" data-a="toc"><i data-lucide="list-tree" class="w-4 h-4"></i> Índice</button>
      <button class="menu-item" data-a="copy-md"><i data-lucide="clipboard-copy" class="w-4 h-4"></i> Copiar Markdown</button>
      <button class="menu-item" data-a="copy-html"><i data-lucide="code" class="w-4 h-4"></i> Copiar HTML</button>
      <button class="menu-item" data-a="rename-doc"><i data-lucide="pen-line" class="w-4 h-4"></i> Renombrar</button>
      <button class="menu-item" data-a="dup-doc"><i data-lucide="copy" class="w-4 h-4"></i> Duplicar</button>
      <button class="menu-item" data-a="export"><i data-lucide="download" class="w-4 h-4"></i> Exportar .md</button>
      <div class="my-1 border-t border-line/70"></div>
      <button class="menu-item danger" data-a="del-doc"><i data-lucide="trash-2" class="w-4 h-4"></i> Eliminar</button>`;
  } else if (currentRoute !== 'trash' && p) {
    html = `
      <button class="menu-item" data-a="new-doc"><i data-lucide="file-plus" class="w-4 h-4"></i> Nuevo documento</button>
      <button class="menu-item" data-a="rename-proj"><i data-lucide="pen-line" class="w-4 h-4"></i> Renombrar proyecto</button>
      <div class="my-1 border-t border-line/70"></div>
      <button class="menu-item danger" data-a="del-proj"><i data-lucide="trash-2" class="w-4 h-4"></i> Eliminar proyecto</button>`;
  } else {
    html = `
      <button class="menu-item" data-a="new-proj"><i data-lucide="folder-plus" class="w-4 h-4"></i> Nuevo proyecto</button>
      <button class="menu-item" data-a="trash"><i data-lucide="trash-2" class="w-4 h-4"></i> Abrir papelera</button>`;
  }
  dd.innerHTML = html;
  dd.querySelectorAll('[data-a]').forEach((b) => {
    b.onclick = () => {
      dd.classList.add('hidden');
      const a = b.dataset.a;
      if (a === 'read') openReading();
      if (a === 'toc') toggleToc();
      if (a === 'copy-md') copyCurrentMarkdown();
      if (a === 'copy-html') copyCurrentHTML();
      if (a === 'rename-doc') askRenameDocument(selectedDocumentId);
      if (a === 'dup-doc') duplicateDocument(selectedDocumentId);
      if (a === 'del-doc') askDeleteDocument(selectedDocumentId);
      if (a === 'export') exportDoc(selectedDocumentId);
      if (a === 'new-doc') createDocument(selectedProjectId);
      if (a === 'rename-proj') askRenameProject(selectedProjectId);
      if (a === 'del-proj') askDeleteProject(selectedProjectId);
      if (a === 'new-proj') askNewProject();
      if (a === 'trash') { currentRoute = 'trash'; render(); }
    };
  });
}

function exportDoc(id) {
  const d = documents.find((x) => x.id === id);
  if (!d) return;
  const blob = new Blob([d.content || ''], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${d.title || 'Sin título'}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Documento exportado', 'download');
}

/* ---------- Vista de proyecto ---------- */
function renderProjectView() {
  const p = currentProject();
  if (!p) return;
  const docs = projectDocs(p.id);
  $('#projectHeader').innerHTML = `
    <div class="flex items-start gap-3">
      <div class="w-11 h-11 rounded-xl bg-[#f0efed] flex items-center justify-center shrink-0">
        <i data-lucide="folder" class="w-5 h-5 text-ink-700"></i>
      </div>
      <div class="min-w-0 flex-1">
        <h1 class="text-[24px] font-bold tracking-tight truncate">${esc(p.name)}</h1>
        <p class="text-[12.5px] text-ink-400 mt-0.5">${docs.length} documento(s) · actualizado ${timeAgo(p.updatedAt)}</p>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button id="btnRenameProj" class="icon-btn" title="Renombrar proyecto"><i data-lucide="pen-line" class="w-4 h-4"></i></button>
        <button id="btnDelProj" class="icon-btn hover:!text-red-600" title="Eliminar proyecto"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
      </div>
    </div>`;
  $('#btnRenameProj').onclick = () => askRenameProject(p.id);
  $('#btnDelProj').onclick = () => askDeleteProject(p.id);

  const grid = $('#docGrid');
  $('#emptyDocs').classList.toggle('hidden', docs.length > 0);
  grid.innerHTML = '';
  docs.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'doc-row group flex items-center gap-3 px-3 py-2.5 rounded-lg border border-transparent hover:border-line cursor-pointer';
    row.innerHTML = `
      <span class="w-8 h-8 rounded-md bg-[#f5f5f4] border border-line/60 flex items-center justify-center shrink-0">
        <i data-lucide="file-text" class="w-4 h-4 text-ink-500"></i>
      </span>
      <div class="min-w-0 flex-1" data-open>
        <p class="text-[13.5px] font-medium truncate">${esc(d.title || 'Sin título')}.md</p>
        <p class="text-[12px] text-ink-400 truncate">${esc(excerpt(d.content) || 'Sin contenido')} · ${timeAgo(d.updatedAt)}</p>
      </div>
      <div class="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
        <button class="icon-btn !w-7 !h-7" data-a="rename" title="Renombrar"><i data-lucide="pen-line" class="w-3.5 h-3.5 pointer-events-none"></i></button>
        <button class="icon-btn !w-7 !h-7" data-a="dup" title="Duplicar"><i data-lucide="copy" class="w-3.5 h-3.5 pointer-events-none"></i></button>
        <button class="icon-btn !w-7 !h-7 hover:!text-red-600" data-a="del" title="Eliminar"><i data-lucide="trash-2" class="w-3.5 h-3.5 pointer-events-none"></i></button>
      </div>`;
    row.querySelector('[data-open]').onclick = () => openDocument(d.id);
    row.querySelector('[data-a="rename"]').onclick = (e) => { e.stopPropagation(); askRenameDocument(d.id); };
    row.querySelector('[data-a="dup"]').onclick = (e) => { e.stopPropagation(); duplicateDocument(d.id); };
    row.querySelector('[data-a="del"]').onclick = (e) => { e.stopPropagation(); askDeleteDocument(d.id); };
    grid.appendChild(row);
  });
  refreshIcons();
}

/* ---------- Editor ---------- */
const TOOLBAR = [
  { icon: 'bold', label: 'Negrita', before: '**', after: '**' },
  { icon: 'italic', label: 'Cursiva', before: '*', after: '*' },
  { icon: 'strikethrough', label: 'Tachado', before: '~~', after: '~~' },
  { sep: true },
  { icon: 'heading-1', label: 'Título', line: '# ' },
  { icon: 'heading-2', label: 'Subtítulo', line: '## ' },
  { icon: 'heading-3', label: 'Subtítulo 3', line: '### ' },
  { sep: true },
  { icon: 'list', label: 'Lista', line: '- ' },
  { icon: 'list-ordered', label: 'Lista numerada', line: '1. ' },
  { icon: 'quote', label: 'Cita', line: '> ' },
  { sep: true },
  { icon: 'code', label: 'Código', before: '`', after: '`' },
  { icon: 'square-code', label: 'Bloque de código', before: '```js\n', after: '\n```' },
  { icon: 'link', label: 'Enlace', before: '[', after: '](https://)' },
  { icon: 'table', label: 'Tabla', insert: '\n| Col 1 | Col 2 |\n| --- | --- |\n| A | B |\n' },
];

function buildToolbar() {
  const tb = $('#toolbar');
  if (tb.dataset.built === '1') { refreshIcons(); return; }
  tb.dataset.built = '1';
  tb.innerHTML = '';
  TOOLBAR.forEach((t) => {
    if (t.sep) { const s = document.createElement('span'); s.className = 'w-px h-5 bg-line mx-1 shrink-0'; tb.appendChild(s); return; }
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.title = t.label;
    b.innerHTML = `<i data-lucide="${t.icon}" class="w-4 h-4 pointer-events-none"></i>`;
    b.onclick = () => applyFormat(t);
    tb.appendChild(b);
  });
  const sep = document.createElement('span');
  sep.className = 'w-px h-5 bg-line mx-1 shrink-0';
  tb.appendChild(sep);
  const copyBtn = document.createElement('button');
  copyBtn.className = 'tool-btn'; copyBtn.title = 'Copiar Markdown';
  copyBtn.innerHTML = `<i data-lucide="clipboard-copy" class="w-4 h-4 pointer-events-none"></i>`;
  copyBtn.onclick = copyCurrentMarkdown;
  const readBtn = document.createElement('button');
  readBtn.className = 'tool-btn'; readBtn.title = 'Modo lectura';
  readBtn.innerHTML = `<i data-lucide="book-open" class="w-4 h-4 pointer-events-none"></i>`;
  readBtn.onclick = openReading;
  const tocBtn = document.createElement('button');
  tocBtn.className = 'tool-btn'; tocBtn.title = 'Mostrar índice (opcional)';
  tocBtn.innerHTML = `<i data-lucide="list-tree" class="w-4 h-4 pointer-events-none"></i>`;
  tocBtn.onclick = () => toggleToc();
  tb.append(copyBtn, readBtn, tocBtn);
  refreshIcons();
}

function applyFormat(t) {
  const ta = $('#editor');
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const sel = value.slice(s, e) || 'texto';
  let next = value, pos;
  if (t.insert) {
    next = value.slice(0, s) + t.insert + value.slice(e);
    pos = s + t.insert.length;
  } else if (t.line) {
    const ls = value.lastIndexOf('\n', s - 1) + 1;
    next = value.slice(0, ls) + t.line + value.slice(ls);
    pos = e + t.line.length;
  } else {
    next = value.slice(0, s) + t.before + sel + t.after + value.slice(e);
    pos = s + t.before.length + sel.length + t.after.length;
  }
  ta.value = next;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  onEditorInput();
}

function renderEditor() {
  const d = currentDoc();
  if (!d) return;
  buildToolbar();
  const title = $('#docTitle');
  const ta = $('#editor');
  if (document.activeElement !== title && title.value !== (d.title || '')) title.value = d.title === 'Sin título' ? '' : d.title;
  title.placeholder = 'Sin título';
  if (document.activeElement !== ta && ta.value !== (d.content || '')) ta.value = d.content || '';
  if (lastEditorDocId !== d.id) {
    lastEditorDocId = d.id;
    ta.value = d.content || '';
    resetEditorScroll();
  }
  syncCrumbTitle(d);
  const meta = `Creado ${fmtDate(d.createdAt)} · Editado ${timeAgo(d.updatedAt)}`;
  $('#footMeta').textContent = meta;
  $('#docMeta').textContent = `${meta} · ${countWords(d.content)} palabras`;
  $('#wordCount').textContent = `${countWords(ta.value)} palabras`;
  applyViewMode();
  renderPreview();
  buildToc();
}

function renderPreview() {
  // Rendimiento: no renderizar si el panel está oculto (modo solo-edición)
  if (viewMode === 'edit') return;
  const ta = $('#editor');
  const raw = ta ? ta.value : (currentDoc()?.content || '');
  let html = '';
  try {
    const dirty = marked.parse(raw || '*Nada que previsualizar todavía…*');
    html = DOMPurify.sanitize(dirty);
  } catch { html = '<p>Error al renderizar Markdown.</p>'; }
  const prev = $('#preview');
  if (prev._last !== html) { prev.innerHTML = html; prev._last = html; }
  buildToc();
}
function queuePreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => { previewQueued = false; renderPreview(); });
}

function applyViewMode() {
  const edit = $('#paneEdit'), prev = $('#panePreview'), panes = $('#panes');
  edit.classList.remove('hidden');
  prev.classList.remove('hidden');
  prev.classList.add('border-l');
  panes.classList.remove('split-mobile-stack');
  if (viewMode === 'edit') { prev.classList.add('hidden'); }
  if (viewMode === 'preview') { edit.classList.add('hidden'); prev.classList.remove('border-l'); }
  if (viewMode === 'split' && window.matchMedia('(max-width: 900px)').matches) {
    panes.classList.add('split-mobile-stack');
  }
  if (viewMode !== 'edit') renderPreview();
}

function markSaving() {
  $('#saveStatusText').textContent = 'Guardando…';
}
function markSaved() {
  $('#saveStatusText').textContent = 'Guardado ' + timeAgo(currentDoc()?.updatedAt);
}

function onEditorInput() {
  const d = currentDoc();
  if (!d) return;
  markSaving();
  queuePreview();
  $('#wordCount').textContent = `${countWords($('#editor').value)} palabras`;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveDocContent(d.id, $('#editor').value, undefined);
    const meta = `Creado ${fmtDate(d.createdAt)} · Editado ${timeAgo(d.updatedAt)}`;
    $('#footMeta').textContent = meta;
    $('#docMeta').textContent = `${meta} · ${countWords(d.content)} palabras`;
    markSaved();
    renderSidebar();
  }, 500);
}
function onTitleInput() {
  const d = currentDoc();
  if (!d) return;
  markSaving();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const v = $('#docTitle').value;
    saveDocContent(d.id, undefined, v || 'Sin título');
    markSaved();
    renderSidebar(); renderMenu();
    syncCrumbTitle(d);
  }, 500);
}

/* ---------- Modo lectura (pantalla completa, sin distracciones) ---------- */
function applyReadFont() {
  document.documentElement.style.setProperty('--read-fs', (prefs.readFontSize || 17) + 'px');
}
function openReading() {
  const d = currentDoc();
  if (!d || currentRoute !== 'editor') { toast('Abre un documento primero', 'info'); return; }
  // Guardar cambios pendientes al instante para leer lo último escrito
  saveDocContent(d.id, $('#editor').value, $('#docTitle').value || 'Sin título');
  const title = d.title || 'Sin título';
  $('#readTitle').textContent = title + '.md';
  $('#readH1').textContent = title;
  const p = currentProject();
  $('#readMeta').textContent = `${p?.name || ''} · ${countWords(d.content)} palabras · ${timeAgo(d.updatedAt)}`;
  let html = '';
  try { html = DOMPurify.sanitize(marked.parse(d.content || '*Documento vacío.*')); }
  catch { html = '<p>Error al renderizar.</p>'; }
  $('#readArticle').innerHTML = html;
  applyReadFont();
  $('#readOverlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  applyTocVisibility();
  buildToc();
  refreshIcons();
}
function closeReading() {
  $('#readOverlay').classList.add('hidden');
  document.body.style.overflow = '';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  render();
}
async function toggleReadFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('#readOverlay').requestFullscreen();
  } catch { toast('Tu navegador no permitió el fullscreen', 'info'); }
}

/* ---------- Papelera: render ---------- */
function renderTrash() {
  const list = $('#trashList');
  const items = [
    ...trash.projects.map((p) => ({ kind: 'proj', id: p.id, name: p.name, date: p.deletedAt })),
    ...trash.documents.map((d) => ({ kind: 'doc', id: d.id, name: (d.title || 'Sin título') + '.md', date: d.deletedAt, extra: d.projectName })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));
  $('#btnEmptyTrash').style.display = items.length ? '' : 'none';
  list.innerHTML = items.length ? '' : `<div class="text-center py-12 border border-dashed border-line rounded-xl"><p class="text-[14px] font-medium">Papelera vacía</p><p class="text-[13px] text-ink-500">Nada por aquí.</p></div>`;
  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 px-3 py-2.5 rounded-lg border border-line/70 bg-white';
    row.innerHTML = `
      <i data-lucide="${it.kind === 'proj' ? 'folder' : 'file-text'}" class="w-4 h-4 text-ink-400 shrink-0"></i>
      <div class="min-w-0 flex-1">
        <p class="text-[13.5px] font-medium truncate">${esc(it.name)}</p>
        <p class="text-[12px] text-ink-400">${it.kind === 'proj' ? 'Proyecto' : 'Documento' + (it.extra ? ' · ' + esc(it.extra) : '')} · eliminado ${timeAgo(it.date)}</p>
      </div>
      <button class="btn-secondary !py-1.5 !px-2.5 !text-[12px]" data-a="restore"><i data-lucide="archive-restore" class="w-3.5 h-3.5 pointer-events-none"></i> Restaurar</button>
      <button class="icon-btn hover:!text-red-600" data-a="destroy" title="Eliminar definitivamente"><i data-lucide="x" class="w-4 h-4 pointer-events-none"></i></button>`;
    row.querySelector('[data-a="restore"]').onclick = () => restoreTrashItem(it.kind, it.id);
    row.querySelector('[data-a="destroy"]').onclick = async () => {
      const ok = await openModal({ title: 'Eliminar definitivamente', desc: `"${it.name}" se eliminará para siempre. Esta acción no se puede deshacer.`, okText: 'Eliminar para siempre', okDanger: true });
      if (ok) destroyTrashItem(it.kind, it.id);
    };
    list.appendChild(row);
  });
  refreshIcons();
}

/* ---------- Búsqueda global ---------- */
function openSearch() {
  $('#searchOverlay').classList.remove('hidden');
  $('#searchInput').value = '';
  searchIndex = -1;
  renderSearchResults('');
  setTimeout(() => $('#searchInput').focus(), 40);
}
function closeSearch() { $('#searchOverlay').classList.add('hidden'); }

function allSearchable() {
  const out = [];
  documents.forEach((d) => {
    const p = projects.find((x) => x.id === d.projectId);
    out.push({ doc: d, project: p });
  });
  return out.sort((a, b) => new Date(b.doc.updatedAt) - new Date(a.doc.updatedAt));
}
function renderSearchResults(q) {
  const box = $('#searchResults');
  q = q.trim().toLowerCase();
  const items = allSearchable().filter(({ doc, project }) => {
    if (!q) return true;
    return (doc.title || '').toLowerCase().includes(q) || (doc.content || '').toLowerCase().includes(q) || (project?.name || '').toLowerCase().includes(q);
  }).slice(0, 20);
  if (!items.length) {
    box.innerHTML = `<p class="text-[13px] text-ink-400 text-center py-8">Sin resultados para “${esc(q)}”.</p>`;
    return;
  }
  box.innerHTML = '';
  items.forEach(({ doc, project }, i) => {
    const b = document.createElement('button');
    b.className = 'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-[#f5f5f4] ' + (i === searchIndex ? 'bg-[#f0efed]' : '');
    b.innerHTML = `
      <i data-lucide="file-text" class="w-4 h-4 text-ink-400 shrink-0"></i>
      <span class="min-w-0 flex-1">
        <span class="block text-[13.5px] font-medium truncate">${esc(doc.title || 'Sin título')}.md</span>
        <span class="block text-[12px] text-ink-400 truncate">${esc(project?.name || '—')} · ${esc(excerpt(doc.content, 60))}</span>
      </span>
      <span class="text-[11px] text-ink-400 shrink-0">${timeAgo(doc.updatedAt)}</span>`;
    b.onclick = () => { closeSearch(); selectedProjectId = doc.projectId; openDocument(doc.id); };
    b.onmousemove = () => { searchIndex = i; renderSearchResults($('#searchInput').value); };
    box.appendChild(b);
  });
  refreshIcons();
}

/* ============================================================
   EVENTOS
   ============================================================ */
function bindEvents() {
  $('#btnNewProject').onclick = askNewProject;
  $('#btnNewProjectRail').onclick = askNewProject;
  $('#btnNewProjectWelcome').onclick = askNewProject;
  $('#btnNewDocTop').onclick = () => createDocument(selectedProjectId);
  $('#btnNewDocEmpty').onclick = () => createDocument(selectedProjectId);
  $('#fabNew').onclick = () => {
    if (currentRoute === 'editor') createDocument(selectedProjectId);
    else if (selectedProjectId) createDocument(selectedProjectId);
    else askNewProject();
  };
  $('#btnTrash').onclick = () => { currentRoute = 'trash'; selectedDocumentId = null; persistPrefs(); render(); };
  $('#btnEmptyTrash').onclick = async () => {
    const ok = await openModal({ title: 'Vaciar papelera', desc: 'Se eliminarán definitivamente todos los elementos. Esta acción no se puede deshacer.', okText: 'Vaciar papelera', okDanger: true });
    if (ok) emptyTrash();
  };
  $('#btnCollapse').onclick = () => { prefs.sidebarCollapsed = true; savePreferences(prefs); render(); };
  $('#btnExpand').onclick = () => { prefs.sidebarCollapsed = false; savePreferences(prefs); render(); };
  $('#btnHamburger').onclick = toggleDrawer;
  $('#btnBack').onclick = () => goHist(-1);
  $('#btnFwd').onclick = () => goHist(1);
  $('#sideBackdrop').onclick = closeDrawer;

  // Tema oscuro
  $('#btnTheme').onclick = toggleTheme;

  // Copia rápida + lectura
  $('#btnCopyFast').onclick = copyCurrentMarkdown;
  $('#btnRead').onclick = openReading;
  $('#readClose').onclick = closeReading;
  $('#readFull').onclick = toggleReadFullscreen;
  $('#readCopy').onclick = () => copyText($('#readArticle').innerText, 'Texto copiado');
  $('#readTheme').onclick = toggleTheme;
  $('#readFontUp').onclick = () => { prefs.readFontSize = Math.min((prefs.readFontSize || 17) + 1, 24); savePreferences(prefs); applyReadFont(); };
  $('#readFontDown').onclick = () => { prefs.readFontSize = Math.max((prefs.readFontSize || 17) - 1, 13); savePreferences(prefs); applyReadFont(); };

  // Índice opcional
  $('#btnToc').onclick = () => toggleToc();
  $('#tocClose').onclick = () => toggleToc(false);
  $('#readTocBtn').onclick = () => toggleToc();
  $('#readTocClose').onclick = () => toggleToc(false);
  $('#panePreview').addEventListener('scroll', queueTocSpy, { passive: true });

  const openS = () => openSearch();
  $('#btnSearchSide').onclick = openS;
  $('#btnSearchRail').onclick = openS;
  $('#btnSearchTop').onclick = openS;
  $('#searchInput').addEventListener('input', (e) => { searchIndex = -1; renderSearchResults(e.target.value); });
  $('#searchOverlay').addEventListener('mousedown', (e) => { if (e.target.id === 'searchOverlay') closeSearch(); });

  $('#btnMenu').onclick = (e) => { e.stopPropagation(); $('#menuDropdown').classList.toggle('hidden'); };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menuDropdown') && !e.target.closest('#btnMenu')) $('#menuDropdown').classList.add('hidden');
  });

  $$('#viewSwitcher .seg-btn').forEach((b) => {
    b.onclick = () => { viewMode = b.dataset.view; persistPrefs(); applyViewMode(); render(); };
  });

  $('#editor').addEventListener('input', onEditorInput);
  $('#docTitle').addEventListener('input', onTitleInput);

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#searchOverlay').classList.contains('hidden') ? openSearch() : closeSearch(); }
    if (e.key === 'Escape') {
      if (!$('#readOverlay').classList.contains('hidden')) { closeReading(); return; }
      if (!$('#searchOverlay').classList.contains('hidden')) closeSearch();
      closeAllPopups();
    }
    // Atajos: Ctrl/Cmd+Shift+C = copiar markdown · Ctrl/Cmd+. = modo lectura
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copyCurrentMarkdown(); }
    if ((e.ctrlKey || e.metaKey) && e.key === '.') { e.preventDefault(); $('#readOverlay').classList.contains('hidden') ? openReading() : closeReading(); }
    // Alt+← / Alt+→ = atrás / adelante (no interfiere al escribir en campos)
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      goHist(e.key === 'ArrowLeft' ? -1 : 1);
    }
    if (!$('#searchOverlay').classList.contains('hidden')) {
      const items = $('#searchResults').querySelectorAll('button');
      if (e.key === 'ArrowDown') { e.preventDefault(); searchIndex = Math.min(searchIndex + 1, items.length - 1); renderSearchResults($('#searchInput').value); }
      if (e.key === 'ArrowUp') { e.preventDefault(); searchIndex = Math.max(searchIndex - 1, 0); renderSearchResults($('#searchInput').value); }
      if (e.key === 'Enter' && items[searchIndex]) { e.preventDefault(); items[searchIndex].click(); }
    }
  });

  // Tab dentro del editor inserta 2 espacios
  $('#editor').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const { selectionStart: s, selectionEnd: en, value } = ta;
      ta.value = value.slice(0, s) + '  ' + value.slice(en);
      ta.setSelectionRange(s + 2, s + 2);
      onEditorInput();
    }
  });

  // Re-colocar split en responsive al rotar/redimensionar
  window.addEventListener('resize', () => { applyViewMode(); });

  // Guardar al salir por seguridad
  window.addEventListener('beforeunload', () => {
    const d = currentDoc();
    if (d && currentRoute === 'editor') {
      saveDocContent(d.id, $('#editor').value, $('#docTitle').value || 'Sin título');
    }
  });
}

/* ---------- Init ---------- */
marked.setOptions({ breaks: true, gfm: true });
applyTheme();
applyReadFont();
bindEvents();
render();
refreshIcons();
