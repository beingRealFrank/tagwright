// Tagwright quick check. Runs entirely in the browser: files are never uploaded.
import * as pdfjs from "./vendor/pdf.min.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream } = window.PDFLib;

const PRICE = { simple: 1.25, complex: 3.75, scanned: 1.25 }; // credits at the 100-pack rate ($1.25/credit)

function lookup(ctx, obj) { return obj ? ctx.lookup(obj) : undefined; }
function dictGet(ctx, d, key) { return d instanceof PDFDict ? lookup(ctx, d.get(PDFName.of(key))) : undefined; }
function strVal(o) { return (o instanceof PDFString || o instanceof PDFHexString) ? o.decodeText() : (o ? String(o) : ""); }

async function catalogChecks(bytes) {
  const out = {};
  let doc;
  try { doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); }
  catch (e) { return { error: "Could not read the file structure: " + e.message }; }
  const ctx = doc.context, cat = doc.catalog;
  out.encrypted = doc.isEncrypted;
  const mark = dictGet(ctx, cat, "MarkInfo");
  out.marked = !!(mark && String(dictGet(ctx, mark, "Marked")) === "true");
  out.structTree = !!dictGet(ctx, cat, "StructTreeRoot");
  out.lang = strVal(dictGet(ctx, cat, "Lang"));
  const vp = dictGet(ctx, cat, "ViewerPreferences");
  out.displayTitle = !!(vp && String(dictGet(ctx, vp, "DisplayDocTitle")) === "true");
  out.title = doc.getTitle() || "";
  out.outline = !!dictGet(ctx, cat, "Outlines") && !!dictGet(ctx, dictGet(ctx, cat, "Outlines"), "First");
  const md = dictGet(ctx, cat, "Metadata");
  out.pdfua = false;
  if (md instanceof PDFRawStream) {
    try {
      const raw = md.getContents();
      const txt = new TextDecoder("latin1").decode(raw);
      out.pdfua = /pdfuaid[:\s\S]{0,40}part[^0-9]{0,40}1/.test(txt);
    } catch (e) { /* compressed metadata: skip */ }
  }
  // forms
  const af = dictGet(ctx, cat, "AcroForm");
  const fields = af ? dictGet(ctx, af, "Fields") : undefined;
  out.fields = 0; out.fieldsNoName = 0;
  if (fields instanceof PDFArray) {
    const walk = (arr) => {
      for (let i = 0; i < arr.size(); i++) {
        const f = lookup(ctx, arr.get(i));
        if (!(f instanceof PDFDict)) continue;
        const kids = dictGet(ctx, f, "Kids");
        if (kids instanceof PDFArray && !dictGet(ctx, f, "FT")) { walk(kids); continue; }
        out.fields++;
        if (!dictGet(ctx, f, "TU")) out.fieldsNoName++;
      }
    };
    walk(fields);
  }
  // pages: annotations + tab order, unembedded fonts
  out.pagesWithAnnots = 0; out.pagesBadTabs = 0;
  const unembedded = new Set();
  const seen = new Set();
  const fontsIn = (res) => {
    if (!(res instanceof PDFDict)) return;
    const fonts = dictGet(ctx, res, "Font");
    if (fonts instanceof PDFDict) {
      for (const [, ref] of fonts.entries()) {
        const key = String(ref);
        if (seen.has(key)) continue; seen.add(key);
        const f = lookup(ctx, ref);
        if (!(f instanceof PDFDict)) continue;
        const sub = String(dictGet(ctx, f, "Subtype"));
        if (sub === "/Type3") continue;
        let fd = dictGet(ctx, f, "FontDescriptor");
        if (sub === "/Type0") {
          const df = dictGet(ctx, f, "DescendantFonts");
          const d0 = df instanceof PDFArray ? lookup(ctx, df.get(0)) : undefined;
          fd = d0 ? dictGet(ctx, d0, "FontDescriptor") : undefined;
        }
        const has = fd instanceof PDFDict && ["FontFile", "FontFile2", "FontFile3"].some(k => fd.get(PDFName.of(k)));
        if (!has) unembedded.add(String(dictGet(ctx, f, "BaseFont") || "?").replace(/^\//, ""));
      }
    }
    const xo = dictGet(ctx, res, "XObject");
    if (xo instanceof PDFDict) {
      for (const [, ref] of xo.entries()) {
        const k = String(ref); if (seen.has("x" + k)) continue; seen.add("x" + k);
        const x = lookup(ctx, ref);
        if (x && x.dict && String(x.dict.get(PDFName.of("Subtype"))) === "/Form") fontsIn(lookup(ctx, x.dict.get(PDFName.of("Resources"))));
      }
    }
  };
  for (const page of doc.getPages()) {
    const node = page.node;
    const annots = node.Annots ? node.Annots() : undefined;
    if (annots && annots.size && annots.size() > 0) {
      out.pagesWithAnnots++;
      const tabs = node.get(PDFName.of("Tabs"));
      if (String(tabs) !== "/S") out.pagesBadTabs++;
    }
    fontsIn(node.Resources ? node.Resources() : undefined);
  }
  out.unembedded = [...unembedded];
  return out;
}

async function contentChecks(bytes) {
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const n = pdf.numPages;
  const out = { pages: n, textlessPages: 0, imagePages: 0, figures: 0, figuresNoAlt: 0, headings: 0,
                tables: 0, tablesNoTH: 0, links: 0 };
  try {
    const md = await pdf.getMetadata();
    const m = md && md.metadata;
    out.pdfua = !!(m && (m.get("pdfuaid:part") === "1" || m.get("pdfuaid:part") === 1));
  } catch (e) { out.pdfua = false; }
  const limit = Math.min(n, 200);
  for (let i = 1; i <= limit; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const chars = tc.items.reduce((a, it) => a + (it.str ? it.str.trim().length : 0), 0);
    const ops = await page.getOperatorList();
    const imgs = ops.fnArray.filter(f => f === pdfjs.OPS.paintImageXObject || f === pdfjs.OPS.paintInlineImageXObject).length;
    if (imgs) out.imagePages++;
    if (chars < 20 && imgs) out.textlessPages++;
    const annots = await page.getAnnotations();
    out.links += annots.filter(a => a.subtype === "Link").length;
    let tree = null;
    try { tree = await page.getStructTree(); } catch (e) { tree = null; }
    if (tree) {
      const walk = (node, inTable) => {
        if (!node || !node.children) return { th: false };
        let th = false;
        const role = node.role || "";
        if (role === "Figure") { out.figures++; if (!node.alt || /^(image|figure|picture|img|graphic)?\s*\d*$|\.(png|jpe?g|gif|tiff?|bmp)$/i.test(node.alt.trim())) out.figuresNoAlt++; }
        if (/^H[1-6]?$/.test(role)) out.headings++;
        if (role === "TH") th = true;
        for (const c of node.children) { const r = walk(c, inTable || role === "Table"); th = th || r.th; }
        if (role === "Table") { out.tables++; if (!th) out.tablesNoTH++; }
        return { th };
      };
      walk(tree, false);
    }
    page.cleanup();
  }
  out.sampled = limit;
  await (pdf.destroy ? pdf.destroy() : pdf.loadingTask?.destroy?.());
  return out;
}

function grade(c, k) {
  const R = [];
  const add = (ok, label, detail, weight = 1) => R.push({ ok, label, detail, weight });
  add(k.structTree && k.marked, "Tagged PDF (has a structure tree)",
      k.structTree ? (k.marked ? "Tags present." : "Structure tree present but the file is not marked as tagged.") :
      "No tags. Screen readers have to guess the reading order, headings, lists and tables.", 3);
  add(c.textlessPages === 0, "Text is real text, not a picture of text",
      c.textlessPages ? `${c.textlessPages} page(s) look scanned: they need OCR before anything else.` : "Every page has selectable text.", 3);
  add(!!k.lang, "Document language is set", k.lang ? `Language: ${k.lang}.` : "No language set, so screen readers may use the wrong voice and pronunciation.", 2);
  add(!!k.title && k.displayTitle, "Title is set and shown",
      k.title ? (k.displayTitle ? `Title: “${k.title}”.` : `Title “${k.title}” exists but viewers show the file name instead.`) : "No document title.", 1);
  if (k.structTree) {
    add(c.figures === 0 || c.figuresNoAlt === 0, "Images have alternative text",
        c.figures ? `${c.figures - c.figuresNoAlt} of ${c.figures} tagged figures have meaningful alt text.` : "No tagged figures found.", 2);
    add(c.headings > 0 || c.pages <= 2, "Headings are tagged", c.headings ? `${c.headings} heading tags.` : "No heading tags: screen-reader users cannot jump between sections.", 2);
    add(c.tables === 0 || c.tablesNoTH === 0, "Tables have header cells",
        c.tables ? `${c.tables - c.tablesNoTH} of ${c.tables} tables have header cells.` : "No tagged tables found.", 2);
  }
  add(k.unembedded.length === 0, "Fonts are embedded", k.unembedded.length ? `Not embedded: ${k.unembedded.slice(0, 5).join(", ")}${k.unembedded.length > 5 ? "…" : ""}.` : "All fonts embedded.", 1);
  if (k.pagesWithAnnots) add(k.pagesBadTabs === 0, "Tab order follows the structure", k.pagesBadTabs ? `${k.pagesBadTabs} page(s) with links or fields don't set tab order.` : "Set on every page with links or fields.", 1);
  if (k.fields) add(k.fieldsNoName === 0, "Form fields have accessible names", `${k.fields - k.fieldsNoName} of ${k.fields} fields have a name (tooltip).`, 2);
  if (c.pages > 20) add(k.outline, "Bookmarks for long documents", k.outline ? "Bookmarks present." : `${c.pages} pages and no bookmarks.`, 1);
  add(k.pdfua || c.pdfua, "Declares PDF/UA (ISO 14289-1)", (k.pdfua || c.pdfua) ? "PDF/UA identifier present (a claim, not proof)." : "No PDF/UA identifier.", 1);
  return R;
}

function estimate(c, k) {
  const complex = c.tables > 0 || k.fields > 0 || c.figures > 5;
  const per = (complex ? PRICE.complex : PRICE.simple) + (c.textlessPages ? PRICE.scanned : 0);
  return { complex, per, total: per * c.pages };
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, v);
  for (const k of kids) e.append(k);
  return e;
}

async function checkFile(file, results) {
  let row = null;
  const box = el("section", { class: "result", "aria-live": "polite" });
  const h = el("h3", {}, file.name);
  box.append(h, el("p", {}, "Checking…"));
  results.append(box);
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const k = await catalogChecks(buf.slice());
    if (k.error) throw new Error(k.error);
    const c = await contentChecks(buf.slice());
    const R = grade(c, k);
    if (window.twHit) window.twHit("check_run");
    const total = R.reduce((a, r) => a + r.weight, 0), got = R.reduce((a, r) => a + (r.ok ? r.weight : 0), 0);
    const score = Math.round(100 * got / total);
    const fails = R.filter(r => !r.ok).length;
    box.lastChild.remove();
    box.append(el("p", { class: "score" }, `${c.pages} page${c.pages === 1 ? "" : "s"} · `,
      el("strong", {}, `${fails === 0 ? "No problems found by the quick check" : fails + " problem" + (fails === 1 ? "" : "s") + " found"}`),
      ` · score ${score}/100`));
    const ul = el("ul", { class: "checks" });
    for (const r of R) ul.append(el("li", { class: r.ok ? "ok" : "bad" }, el("span", { class: "mark", "aria-hidden": "true" }, r.ok ? "✓" : "✗"),
      el("span", { class: "sr" }, r.ok ? "Pass: " : "Problem: "), el("strong", {}, r.label), " — ", r.detail));
    box.append(ul);
    if (fails) {
      const est = estimate(c, k);
      box.append(el("p", { class: "quote" }, `Tagwright fix: about $${est.total.toFixed(2)} (${c.pages} × $${est.per.toFixed(2)}/page, ${est.complex ? "complex" : "simple"} document${c.textlessPages ? ", needs OCR" : ""}). `,
        el("a", { href: "#order" }, "Get it fixed"), ". Your first 3 pages are free."));
    }
    box.append(el("p", { class: "fine" }, "A quick check reads the file's structure. It is not a full PDF/UA audit; Tagwright runs veraPDF and a reviewed checklist on every file it fixes."));
    window.tagwrightLast = { pages: c.pages, score, fails };
    const est = estimate(c, k);
    row = { file: file.name, pages: c.pages, tagged: k.structTree && k.marked ? "yes" : "no", language: k.lang || "",
            title: k.title || "", scanned_pages: c.textlessPages, images_without_alt: k.structTree ? c.figuresNoAlt : "",
            problems: fails, score, est_fix_usd: fails ? Math.round(est.total * 100) / 100 : 0 };
  } catch (e) {
    box.lastChild.remove();
    box.append(el("p", { class: "bad" }, "Could not check this file: " + e.message + (/encrypt|password/i.test(e.message) ? " (it may be password-protected)." : "")));
    row = { file: file.name, pages: "", tagged: "", language: "", title: "", scanned_pages: "", images_without_alt: "",
            problems: "", score: "", est_fix_usd: "", note: "could not be read" };
  }
  return row;
}

const COLS = [["file", "File"], ["pages", "Pages"], ["tagged", "Tagged"], ["language", "Language"], ["title", "Title"],
              ["scanned_pages", "Scanned pages"], ["images_without_alt", "Images without alt text"],
              ["problems", "Problems"], ["score", "Score"], ["est_fix_usd", "Est. fix ($)"]];

function csvCell(v) {
  let t = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // stop spreadsheet formula injection from file names and titles
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

function renderInventory(rows, results) {
  const sec = el("section", { class: "result", id: "inventory" });
  sec.append(el("h3", {}, `Inventory: ${rows.length} file${rows.length === 1 ? "" : "s"}`));
  const tot = rows.reduce((a, r) => a + (Number(r.est_fix_usd) || 0), 0), pg = rows.reduce((a, r) => a + (Number(r.pages) || 0), 0);
  sec.append(el("p", {}, `${pg} pages in total. Estimated cost to fix every file with problems: about $${tot.toFixed(2)}. `,
    el("a", { href: "order.html" }, "Fix these"), " (the first 3 pages of one file are free)."));
  const tbl = el("table", { class: "inv" });
  const cap = el("caption", { class: "sr" }, "Per-file results. Select a column heading to sort.");
  const thead = el("thead"), htr = el("tr"), tbody = el("tbody");
  let sortKey = null, asc = true;
  const draw = () => {
    tbody.textContent = "";
    const sorted = [...rows];
    if (sortKey) sorted.sort((a, b) => { const x = a[sortKey], y = b[sortKey]; const n = (typeof x === "number" && typeof y === "number");
      return (n ? x - y : String(x).localeCompare(String(y))) * (asc ? 1 : -1); });
    for (const r of sorted) { const tr = el("tr"); for (const [key] of COLS) tr.append(el(key === "file" ? "th" : "td", key === "file" ? { scope: "row" } : {}, String(r[key] ?? ""))); tbody.append(tr); }
  };
  for (const [key, label] of COLS) {
    const b = el("button", { type: "button", class: "sortbtn" }, label);
    b.addEventListener("click", () => { asc = sortKey === key ? !asc : true; sortKey = key; draw();
      for (const th of htr.children) th.setAttribute("aria-sort", "none"); b.parentElement.setAttribute("aria-sort", asc ? "ascending" : "descending"); });
    htr.append(el("th", { scope: "col", "aria-sort": "none" }, b));
  }
  thead.append(htr); tbl.append(cap, thead, tbody); draw();
  sec.append(el("div", { class: "tablewrap" }, tbl));
  const dl = el("button", { type: "button" }, "Download CSV");
  dl.addEventListener("click", () => {
    const lines = [COLS.map(c => c[1]).join(",")].concat(rows.map(r => COLS.map(([k]) => csvCell(r[k])).join(",")));
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv" });
    const a = el("a", { href: URL.createObjectURL(blob), download: "pdf-inventory.csv" }); document.body.append(a); a.click(); a.remove();
    window.tagwrightCsv = lines.join("\r\n");
  });
  sec.append(el("p", {}, dl, el("span", { class: "fine" }, " Everything above was computed in your browser; no file was uploaded.")));
  results.prepend(sec);
}

const input = document.getElementById("pdf-input");
const drop = document.getElementById("drop");
const results = document.getElementById("results");
async function handle(files) {
  results.textContent = "";
  const rows = [];
  for (const f of [...files].slice(0, 60)) {
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") continue;
    const row = await checkFile(f, results);
    if (row) { rows.push(row); window.tagwrightRows = rows; }
  }
  if (rows.length > 1) renderInventory(rows, results);
}
input.addEventListener("change", () => handle(input.files));
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); handle(e.dataTransfer.files); });
