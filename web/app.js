import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import { AdbDaemonWebUsbDeviceManager, AdbDaemonWebUsbDevice } from "@yume-chan/adb-daemon-webusb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";

/* ---------- utilitaires ---------- */
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(k));
  return n;
};
const fmtSize = (b) => {
  b = Number(b);
  if (b < 1024) return b + " o";
  const u = ["Ko", "Mo", "Go", "To"]; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b < 10 ? 1 : 0).replace(".", ",") + " " + u[i];
};
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return "—";
  s = Math.round(s);
  const m = Math.floor(s / 60), r = s % 60;
  return m ? `${m} min ${String(r).padStart(2, "0")} s` : `${r} s`;
};
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const joinPath = (...p) => p.filter(Boolean).join("/").replace(/\/+/g, "/");
const VIDEO_RE = /\.(mp4|mkv|mov|webm|m4v|avi)$/i;

const ls = {
  get(k, d) { try { const v = localStorage.getItem("c360:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("c360:" + k, JSON.stringify(v)); } catch {} },
};

/* ---------- état ---------- */
const state = {
  adb: null,
  info: null,
  items: [],            // { id, file, collection, status, sent }
  remote: new Map(),    // chemin relatif -> taille
  busy: false,
  cancel: false,
  sessions: [],
  root: ls.get("root", "/sdcard/Movies/360"),
  collections: ls.get("collections", ["Voyage express", "Évasion"]),
  suffix: ls.get("suffix", ""),
  skipSame: ls.get("skipSame", true),
  mirror: false,
};
let nextId = 1;
const store = new AdbWebCredentialStore("Chargeur 360 Quest");
const manager = AdbDaemonWebUsbDeviceManager.BROWSER;

/* ---------- journal ---------- */
function log(msg, kind = "") {
  const t = new Date().toLocaleTimeString("fr-FR");
  const line = el("div", { class: "log-line " + kind }, el("span", { class: "log-t" }, t), " ", msg);
  const box = $("#log");
  box.append(line);
  box.scrollTop = box.scrollHeight;
}

/* ---------- connexion ---------- */
function setConn(mode, text) {
  const pill = $("#conn-pill");
  pill.dataset.mode = mode;
  $("#conn-text").textContent = text;
  $("#btn-connect").hidden = mode === "on" || mode === "auth";
  $("#btn-disconnect").hidden = mode !== "on";
  $("#auth-hint").hidden = mode !== "auth";
  document.body.dataset.conn = mode;
}

async function connect() {
  if (!manager) return;
  try {
    let device;
    const known = await manager.getDevices();
    device = known.length === 1 ? known[0] : await manager.requestDevice();
    if (!device) return;
    setConn("auth", "Autorisation en attente…");
    let connection;
    try {
      connection = await device.connect();
    } catch (e) {
      if (e instanceof AdbDaemonWebUsbDevice.DeviceBusyError) {
        throw new Error("Le casque est déjà utilisé par un autre logiciel (SideQuest, Meta Quest Developer Hub, adb…). Fermez-le, débranchez puis rebranchez le câble.");
      }
      throw e;
    }
    const transport = await AdbDaemonTransport.authenticate({
      serial: device.serial, connection, credentialStore: store,
    });
    state.adb = new Adb(transport);
    state.adb.disconnected.then(() => onDisconnected());
    await loadInfo();
    setConn("on", `${state.info.model} connecté`);
    log(`Connecté à ${state.info.model} (n° ${state.info.serial})`, "ok");
    await refreshRemote();
  } catch (e) {
    console.error(e);
    state.adb = null;
    setConn("off", "Aucun casque");
    if (e?.name === "NotFoundError") return; // fenêtre de choix fermée
    log("Connexion impossible : " + (e?.message || e), "err");
    showError(e?.message || String(e));
  }
}

async function disconnect() {
  try { await state.adb?.close(); } catch {}
  onDisconnected();
}

function onDisconnected() {
  if (!state.adb) return;
  state.adb = null;
  state.info = null;
  state.remote = new Map();
  if (state.busy) state.cancel = true;
  setConn("off", "Aucun casque");
  log("Casque déconnecté.");
  renderInfo(); renderItems(); renderRemote([]);
}

const sh = (cmd) => state.adb.subprocess.noneProtocol.spawnWaitText(cmd);

async function loadInfo() {
  const adb = state.adb;
  const [model, bat, df] = await Promise.all([
    adb.getProp("ro.product.model").catch(() => ""),
    sh("dumpsys battery | grep level").catch(() => ""),
    sh("df -k /sdcard | tail -n 1").catch(() => ""),
  ]);
  const parts = df.trim().split(/\s+/);
  const total = Number(parts[1]) * 1024, used = Number(parts[2]) * 1024, free = Number(parts[3]) * 1024;
  state.info = {
    model: model.trim() || "Meta Quest",
    serial: adb.serial,
    battery: Number((bat.match(/(\d+)/) || [])[1]) || null,
    total: isFinite(total) ? total : null,
    used: isFinite(used) ? used : null,
    free: isFinite(free) ? free : null,
  };
  renderInfo();
}

/* ---------- contenu du casque ---------- */
async function listRecursive(sync, dir, rel = "", depth = 0, out = []) {
  let entries;
  try { entries = await sync.readdir(dir); } catch { return out; }
  for (const e of entries) {
    if (e.name === "." || e.name === "..") continue;
    const type = e.mode >> 12;
    const r = rel ? rel + "/" + e.name : e.name;
    if (type === 0o04 && depth < 3) await listRecursive(sync, dir + "/" + e.name, r, depth + 1, out);
    else if (type === 0o10) out.push({ rel: r, size: Number(e.size), mtime: Number(e.mtime) });
  }
  return out;
}

async function refreshRemote() {
  if (!state.adb) return;
  const sync = await state.adb.sync();
  let files = [];
  try { files = await listRecursive(sync, state.root.replace(/\/$/, "")); }
  finally { await sync.dispose(); }
  state.remote = new Map(files.map((f) => [f.rel, f.size]));
  renderRemote(files);
  renderItems();
}

async function deleteRemote(rel) {
  if (!state.adb || state.busy) return;
  if (!confirm(`Supprimer « ${rel} » du casque ?`)) return;
  try {
    await state.adb.rm(joinPath(state.root, rel), { force: true });
    log(`Supprimé du casque : ${rel}`);
    await loadInfo();
    await refreshRemote();
  } catch (e) { log("Suppression impossible : " + e.message, "err"); }
}

/* ---------- sélection locale ---------- */
function targetName(item) {
  let name = item.file.name;
  if (state.suffix && !name.toLowerCase().includes(state.suffix.toLowerCase() + ".")) {
    name = name.replace(/(\.[^.]+)$/, state.suffix + "$1");
  }
  return item.collection ? item.collection + "/" + name : name;
}

function itemStatus(item) {
  if (item.status === "sending" || item.status === "done" || item.status === "error") return item.status;
  if (!state.adb) return "pending";
  const rs = state.remote.get(targetName(item));
  if (rs == null) return "missing";
  return rs === item.file.size ? "present" : "different";
}

function addFiles(list) {
  const coll = $("#add-collection").value;
  let n = 0;
  for (const f of list) {
    if (!VIDEO_RE.test(f.name) && !f.type.startsWith("video/")) continue;
    // sous-dossier d'origine (sélection de dossier) -> collection si elle correspond
    let collection = coll;
    const rp = f.webkitRelativePath || "";
    const seg = rp.split("/");
    if (seg.length > 2 && state.collections.includes(seg[seg.length - 2])) collection = seg[seg.length - 2];
    if (state.items.some((i) => i.file.name === f.name && i.file.size === f.size && i.collection === collection)) continue;
    state.items.push({ id: nextId++, file: f, collection, status: "", sent: 0 });
    n++;
  }
  if (n) log(`${n} vidéo${n > 1 ? "s" : ""} ajoutée${n > 1 ? "s" : ""} à la sélection.`);
  renderItems();
}

/* ---------- envoi ---------- */
async function send() {
  if (!state.adb || state.busy) return;
  const queue = state.items.filter((i) => {
    i.status = i.status === "done" ? "" : i.status === "error" ? "" : i.status;
    const s = itemStatus(i);
    return s === "missing" || s === "different" || (!state.skipSame && s === "present");
  });

  // miroir : fichiers du casque absents de la sélection
  let toDelete = [];
  if (state.mirror) {
    const wanted = new Set(state.items.map(targetName));
    toDelete = [...state.remote.keys()].filter((r) => !wanted.has(r));
    if (toDelete.length && !confirm(`Mode miroir : ${toDelete.length} vidéo(s) présente(s) sur le casque mais absente(s) de la sélection vont être supprimées :\n\n${toDelete.slice(0, 15).join("\n")}${toDelete.length > 15 ? "\n…" : ""}\n\nContinuer ?`)) return;
  }

  const total = queue.reduce((a, i) => a + i.file.size, 0);
  if (state.info?.free != null && total > state.info.free) {
    const freed = toDelete.reduce((a, r) => a + (state.remote.get(r) || 0), 0);
    if (total > state.info.free + freed) {
      showError(`Espace insuffisant sur le casque : ${fmtSize(total)} à envoyer pour ${fmtSize(state.info.free)} disponibles.`);
      return;
    }
  }
  if (!queue.length && !toDelete.length) {
    log("Rien à envoyer : le casque est déjà à jour.", "ok");
    renderItems();
    return;
  }

  state.busy = true; state.cancel = false;
  document.body.dataset.busy = "1";
  let wake = null;
  try { wake = await navigator.wakeLock?.request("screen"); } catch {}
  const t0 = performance.now();
  let doneBytes = 0, okCount = 0;
  const serial = state.info?.serial, model = state.info?.model;

  try {
    for (const rel of toDelete) {
      if (state.cancel) break;
      await state.adb.rm(joinPath(state.root, rel), { force: true });
      log(`Supprimé (miroir) : ${rel}`);
    }
    for (const item of queue) {
      if (state.cancel) break;
      const rel = targetName(item);
      const dest = joinPath(state.root, rel);
      const dir = dest.slice(0, dest.lastIndexOf("/"));
      item.status = "sending"; item.sent = 0; renderItems();
      log(`Envoi : ${rel} (${fmtSize(item.file.size)})`);
      try {
        await sh(`mkdir -p ${q(dir)}`);
        const sync = await state.adb.sync();
        const counter = new TransformStream({
          transform(chunk, ctrl) {
            if (state.cancel) { ctrl.error(new Error("Envoi annulé")); return; }
            item.sent += chunk.byteLength;
            updateProgress(doneBytes + item.sent, total, t0, item);
            ctrl.enqueue(chunk);
          },
        });
        try {
          await sync.write({ filename: dest, file: item.file.stream().pipeThrough(counter), mtime: Math.floor(item.file.lastModified / 1000) });
        } finally {
          await sync.dispose().catch(() => {});
        }
        doneBytes += item.file.size;
        item.status = "done"; okCount++;
        state.remote.set(rel, item.file.size);
        sh(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${q("file://" + encodeURI(dest))}`).catch(() => {});
        log(`Terminé : ${rel}`, "ok");
      } catch (e) {
        item.status = "error";
        log(`Échec : ${rel} — ${e.message || e}`, "err");
        if (state.adb) await state.adb.rm(dest, { force: true }).catch(() => {});
        if (state.cancel || !state.adb) break;
      }
      renderItems();
    }
  } finally {
    state.busy = false;
    document.body.dataset.busy = "";
    try { await wake?.release(); } catch {}
    updateProgress(0, 0);
    const dur = (performance.now() - t0) / 1000;
    if (state.cancel) log("Envoi interrompu.", "err");
    else log(`Casque prêt : ${okCount} vidéo(s) envoyée(s) en ${fmtTime(dur)}.`, "ok");
    if (serial && !state.cancel) {
      state.sessions.unshift({ model, serial, time: new Date(), count: okCount, bytes: doneBytes, deleted: toDelete.length });
      renderSessions();
      if (state.items.length) showNext();
    }
    state.cancel = false;
    if (state.adb) { await loadInfo().catch(() => {}); await refreshRemote().catch(() => {}); }
    renderItems();
  }
}

function updateProgress(done, total, t0, item) {
  const bar = $("#progress");
  if (!total) { bar.hidden = true; return; }
  bar.hidden = false;
  const el_ = (performance.now() - t0) / 1000;
  const speed = done / Math.max(el_, 0.001);
  const pct = (done / total) * 100;
  $("#progress-fill").style.width = pct.toFixed(1) + "%";
  $("#progress-label").textContent = `${pct.toFixed(0)} % · ${fmtSize(done)} / ${fmtSize(total)}`;
  $("#progress-meta").textContent = `${fmtSize(speed)}/s · reste ${fmtTime((total - done) / speed)}`;
  if (item) {
    const row = document.querySelector(`[data-id="${item.id}"] .row-bar i`);
    if (row) row.style.width = ((item.sent / item.file.size) * 100).toFixed(1) + "%";
  }
}

/* ---------- rendu ---------- */
function renderInfo() {
  const box = $("#device");
  box.replaceChildren();
  const i = state.info;
  if (!i) {
    box.append(el("p", { class: "muted" }, "Branchez un casque en USB puis cliquez sur « Connecter un casque »."));
    return;
  }
  const pct = i.total ? (i.used / i.total) * 100 : 0;
  box.append(
    el("div", { class: "kv" },
      el("div", {}, el("span", {}, "Modèle"), el("b", {}, i.model)),
      el("div", {}, el("span", {}, "N° de série"), el("b", { class: "mono" }, i.serial)),
      el("div", {}, el("span", {}, "Batterie"), el("b", { class: i.battery != null && i.battery < 20 ? "warn" : "" }, i.battery != null ? i.battery + " %" : "—")),
    ),
    el("div", { class: "storage" },
      el("div", { class: "storage-bar" }, el("i", { style: `width:${pct.toFixed(1)}%` })),
      el("div", { class: "storage-txt" }, i.free != null ? `${fmtSize(i.free)} libres sur ${fmtSize(i.total)}` : "Espace inconnu"),
    ),
  );
}

const STATUS = {
  pending: ["", "En attente d'un casque"],
  missing: ["s-missing", "À envoyer"],
  different: ["s-diff", "Différente, sera remplacée"],
  present: ["s-ok", "Déjà sur le casque"],
  sending: ["s-sending", "Envoi…"],
  done: ["s-ok", "Envoyée"],
  error: ["s-err", "Échec"],
};

function renderItems() {
  const list = $("#items");
  list.replaceChildren();
  $("#empty").hidden = state.items.length > 0;
  let toSend = 0, toSendBytes = 0, selBytes = 0;
  for (const item of state.items) {
    const st = itemStatus(item);
    selBytes += item.file.size;
    if (st === "missing" || st === "different" || (!state.skipSame && st === "present")) { toSend++; toSendBytes += item.file.size; }
    const [cls, label] = STATUS[st] || STATUS.pending;
    const sel = el("select", { class: "row-coll", "aria-label": "Dossier", disabled: state.busy, onchange: (e) => { item.collection = e.target.value; renderItems(); } },
      el("option", { value: "" }, "Racine"),
      state.collections.map((c) => el("option", { value: c, selected: c === item.collection }, c)),
    );
    list.append(el("li", { class: "row", "data-id": item.id },
      el("div", { class: "row-main" },
        el("div", { class: "row-name", title: targetName(item) }, item.file.name),
        el("div", { class: "row-sub" }, fmtSize(item.file.size), " · ", el("span", { class: "badge " + cls }, label)),
        st === "sending" ? el("div", { class: "row-bar" }, el("i", { style: `width:${((item.sent / item.file.size) * 100).toFixed(1)}%` })) : null,
      ),
      sel,
      el("button", { class: "icon-btn", title: "Retirer de la sélection", "aria-label": "Retirer", disabled: state.busy, onclick: () => { state.items = state.items.filter((x) => x !== item); renderItems(); } }, "×"),
    ));
  }
  $("#sel-summary").textContent = state.items.length
    ? `${state.items.length} vidéo${state.items.length > 1 ? "s" : ""} · ${fmtSize(selBytes)}`
    : "";
  const btn = $("#btn-send");
  btn.disabled = !state.adb || state.busy || (!toSend && !state.mirror);
  btn.textContent = !state.adb ? "Connectez un casque"
    : toSend ? `Envoyer ${toSend} vidéo${toSend > 1 ? "s" : ""} (${fmtSize(toSendBytes)})`
    : state.items.length ? "Casque à jour" : "Envoyer sur le casque";
  $("#btn-clear").disabled = state.busy || !state.items.length;
}

function renderRemote(files) {
  const list = $("#remote");
  list.replaceChildren();
  $("#remote-root").textContent = state.root;
  if (!state.adb) { list.append(el("li", { class: "muted pad" }, "Aucun casque connecté.")); return; }
  if (!files.length) { list.append(el("li", { class: "muted pad" }, "Aucune vidéo dans ce dossier.")); return; }
  files.sort((a, b) => a.rel.localeCompare(b.rel, "fr"));
  let group = null;
  for (const f of files) {
    const g = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
    if (g !== group) { group = g; list.append(el("li", { class: "group" }, g || "Racine")); }
    list.append(el("li", { class: "rrow" },
      el("span", { class: "rname", title: f.rel }, f.rel.slice(f.rel.lastIndexOf("/") + 1)),
      el("span", { class: "rsize" }, fmtSize(f.size)),
      el("button", { class: "icon-btn", title: "Supprimer du casque", "aria-label": "Supprimer du casque", onclick: () => deleteRemote(f.rel) }, "×"),
    ));
  }
}

function renderSessions() {
  const box = $("#sessions");
  $("#sessions-card").hidden = !state.sessions.length;
  box.replaceChildren(...state.sessions.map((s) =>
    el("li", {},
      el("b", {}, s.model), " ", el("span", { class: "mono muted" }, "…" + s.serial.slice(-5)),
      el("span", { class: "muted" }, ` · ${s.time.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · ${s.count} envoyée(s), ${fmtSize(s.bytes)}${s.deleted ? `, ${s.deleted} supprimée(s)` : ""}`),
    )));
}

function renderCollections() {
  const add = $("#add-collection");
  const cur = add.value;
  add.replaceChildren(el("option", { value: "" }, "Racine"), ...state.collections.map((c) => el("option", { value: c }, c)));
  add.value = state.collections.includes(cur) ? cur : (state.collections[0] || "");
  $("#coll-list").replaceChildren(...state.collections.map((c) =>
    el("span", { class: "chip" }, c, el("button", { "aria-label": "Retirer " + c, onclick: () => {
      state.collections = state.collections.filter((x) => x !== c); ls.set("collections", state.collections);
      state.items.forEach((i) => { if (i.collection === c) i.collection = ""; });
      renderCollections(); renderItems();
    } }, "×"))));
}

function showError(msg) {
  const d = $("#error");
  d.textContent = msg; d.hidden = false;
  clearTimeout(showError.t); showError.t = setTimeout(() => (d.hidden = true), 12000);
}
function showNext() {
  $("#next").hidden = false;
}

/* ---------- init ---------- */
function init() {
  if (!manager || !("usb" in navigator)) {
    $("#nousb").hidden = false;
    $("#btn-connect").disabled = true;
  }
  $("#btn-connect").onclick = () => { $("#next").hidden = true; connect(); };
  $("#btn-disconnect").onclick = disconnect;
  $("#btn-send").onclick = send;
  $("#btn-cancel").onclick = () => { state.cancel = true; };
  $("#btn-refresh").onclick = () => refreshRemote();
  $("#btn-clear").onclick = () => { state.items = []; renderItems(); };
  $("#pick-files").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
  $("#pick-dir").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };

  const drop = $("#drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    const files = [];
    const walk = async (entry, path) => {
      if (entry.isFile) {
        const f = await new Promise((r, j) => entry.file(r, j));
        Object.defineProperty(f, "webkitRelativePath", { value: path + f.name });
        files.push(f);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do { batch = await new Promise((r, j) => reader.readEntries(r, j)); for (const c of batch) await walk(c, path + entry.name + "/"); } while (batch.length);
      }
    };
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) for (const en of entries) await walk(en, "");
    else files.push(...e.dataTransfer.files);
    addFiles(files);
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  const root = $("#opt-root");
  root.value = state.root;
  root.onchange = () => {
    let v = root.value.trim().replace(/\/+$/, "");
    if (!v.startsWith("/sdcard")) v = joinPath("/sdcard", v);
    root.value = state.root = v; ls.set("root", v);
    refreshRemote();
  };
  const suf = $("#opt-suffix");
  suf.value = state.suffix;
  suf.onchange = () => { state.suffix = suf.value; ls.set("suffix", suf.value); renderItems(); };
  const skip = $("#opt-skip");
  skip.checked = state.skipSame;
  skip.onchange = () => { state.skipSame = skip.checked; ls.set("skipSame", skip.checked); renderItems(); };
  const mir = $("#opt-mirror");
  mir.onchange = () => { state.mirror = mir.checked; renderItems(); };
  $("#coll-add").onsubmit = (e) => {
    e.preventDefault();
    const inp = $("#coll-new");
    const v = inp.value.trim().replace(/[\/\\'"]/g, "");
    if (v && !state.collections.includes(v)) { state.collections.push(v); ls.set("collections", state.collections); }
    inp.value = ""; renderCollections(); renderItems();
  };

  window.addEventListener("beforeunload", (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ""; } });
  navigator.usb?.addEventListener("disconnect", () => { if (state.adb) state.adb.close().catch(() => {}); });

  setConn("off", "Aucun casque");
  renderCollections(); renderInfo(); renderItems(); renderRemote([]); renderSessions();
}
init();
