// Verbes haut-niveau pensés pour un agent IA, exécutés sur une page Puppeteer.
//
// Encode une fois pour toutes les pièges du pilotage headless (éprouvés sur de
// vrais sites — Google Ads/Compte, etc., cf coderhammer/work
// tools/remote-browser-control.md) :
//   - traversée du shadow DOM (les Web Components système masquent leurs
//     éléments à un querySelectorAll normal) ;
//   - coordonnées en pixels CSS, viewport-relatives (deviceScaleFactor 1 ici,
//     donc == pixels du screenshot) ;
//   - frappe posée via le setter DOM natif (sinon interceptée par les
//     raccourcis clavier globaux de la page) ;
//   - modèle « snapshot avec refs » : chaque élément interactif reçoit un id
//     stable (data-br-ref) ; l'agent agit par `ref`, sans ambiguïté de texte.

// Injecté tel quel dans page.evaluate. Toutes les fonctions __* y sont dispo.
const PAGE_HELPERS = `
  function* __walk(root) {
    const els = root.querySelectorAll('*');
    for (const e of els) { yield e; if (e.shadowRoot) yield* __walk(e.shadowRoot); }
  }
  function __visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height),
             onscreen: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth };
  }
  function __label(el) {
    let t = (el.getAttribute('aria-label') || '').trim();
    if (!t && el.tagName === 'INPUT') t = (el.getAttribute('placeholder') || el.getAttribute('name') || el.value || '').trim();
    if (!t) t = (el.textContent || '').trim();
    return t.replace(/\\s+/g, ' ').slice(0, 120);
  }
  function __interactive(el) {
    const tag = el.tagName;
    if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    const role = el.getAttribute('role');
    if (role && ['button','link','tab','menuitem','menuitemcheckbox','checkbox','radio','option','switch','textbox','combobox','searchbox'].includes(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.isContentEditable) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && ti !== '-1') return true;
    return false;
  }
  function __clickableAncestor(el) {
    let a = el;
    while (a && !(a.tagName === 'A' || a.tagName === 'BUTTON' || (a.getAttribute && ['button','link','tab','menuitem'].includes(a.getAttribute('role'))))) {
      a = a.parentElement || (a.getRootNode && a.getRootNode().host) || null;
    }
    return a || el;
  }
  // Retrouve un élément par son data-br-ref, shadow DOM inclus (querySelector
  // ne franchit pas les frontières shadow).
  function __byRef(ref) {
    for (const e of __walk(document)) { if (e.getAttribute && e.getAttribute('data-br-ref') === ref) return e; }
    return null;
  }
  // Construit le snapshot des éléments interactifs visibles et LES TAGGE
  // (data-br-ref) pour que les actions suivantes les retrouvent de façon stable.
  function __snapshot() {
    const out = [];
    let i = 0;
    for (const e of __walk(document)) {
      if (!__interactive(e)) continue;
      const vis = __visible(e);
      if (!vis) continue;
      const ref = 'e' + (i++);
      try { e.setAttribute('data-br-ref', ref); } catch (_) {}
      const isField = e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable ||
        ['textbox','searchbox','combobox'].includes(e.getAttribute('role'));
      out.push({ ref, tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || null,
                 type: e.getAttribute('type') || undefined, name: __label(e),
                 value: isField ? (e.value || '') : undefined, editable: isField || undefined,
                 x: vis.x, y: vis.y, w: vis.w, h: vis.h, onscreen: vis.onscreen });
    }
    return out;
  }
`;

// Exécute un corps de fonction en contexte page, helpers __* disponibles.
function inPage(page, args, body) {
  return page.evaluate(
    new Function("__args", `${PAGE_HELPERS}\nreturn (function(){${body}})();`),
    args,
  );
}

// --- Verbes -----------------------------------------------------------------

export async function navigate(page, { url, waitUntil = "networkidle2", timeout = 30000 }) {
  if (!url) throw new Error("navigate: { url } requis");
  await page.goto(url, { waitUntil, timeout });
  return { url: page.url(), title: await page.title().catch(() => "") };
}

// Snapshot sémantique : url + titre + éléments interactifs (avec refs) +
// texte rendu. Un seul appel pour « comprendre l'écran » sans lire une image.
export async function snapshot(page, { withText = true } = {}) {
  const elements = await inPage(page, {}, `return __snapshot();`);
  const result = {
    url: page.url(),
    title: await page.title().catch(() => ""),
    elements,
  };
  if (withText) {
    result.text = await page
      .evaluate(() => document.body?.innerText?.slice(0, 8000) || "")
      .catch(() => "");
  }
  return result;
}

// Clique : par ref (recommandé, issu d'un snapshot), par texte, ou par coords.
export async function click(page, { ref, text, exact = false, nth = 0, x, y, method = "mouse" }) {
  if (typeof x === "number" && typeof y === "number") {
    await page.mouse.click(x, y);
    return { clicked: { x, y } };
  }

  const target = await inPage(page, { ref, text, exact, nth, method }, `
    let real = null;
    if (__args.ref) {
      real = __byRef(__args.ref);
    } else if (__args.text) {
      const needle = __args.text.toLowerCase();
      let i = 0;
      for (const e of __walk(document)) {
        if (!__interactive(e)) continue;
        const v = __visible(e); if (!v) continue;
        const hay = __label(e).toLowerCase();
        if (__args.exact ? hay !== needle : !hay.includes(needle)) continue;
        if (i++ === __args.nth) { real = e; break; }
      }
    }
    if (!real) return null;
    real.scrollIntoView({ block: 'center', inline: 'center' });
    if (__args.method === 'dom') { __clickableAncestor(real).click(); return { method: 'dom', done: true }; }
    const v = __visible(real);
    return v ? { method: 'mouse', x: v.x, y: v.y } : null;
  `);

  if (!target) throw new Error(`click: aucun élément pour ${JSON.stringify({ ref, text, nth })}`);
  if (target.method === "mouse") {
    await new Promise((r) => setTimeout(r, 150)); // laisser le scroll se poser
    await page.mouse.click(target.x, target.y);
  }
  return { clicked: target };
}

// Saisit une valeur dans un champ (par ref, selector CSS, ou libellé). Pose la
// valeur via le setter natif + dispatch input/change ; `submit` presse Entrée.
export async function type(page, { ref, selector, field, value = "", submit = false }) {
  const done = await inPage(page, { ref, selector, field, value }, `
    let el = null;
    if (__args.ref) { el = __byRef(__args.ref); }
    else if (__args.selector) { for (const e of __walk(document)) { if (e.matches && e.matches(__args.selector)) { el = e; break; } } }
    else {
      const needle = (__args.field || '').toLowerCase();
      for (const e of __walk(document)) {
        if (!['INPUT','TEXTAREA'].includes(e.tagName) && !e.isContentEditable) continue;
        if (!__visible(e)) continue;
        if (!needle) { el = e; break; }
        const ph = (e.getAttribute('placeholder') || e.getAttribute('aria-label') || e.name || '').toLowerCase();
        let lbl = '';
        if (e.id) { const l = document.querySelector('label[for=' + CSS.escape(e.id) + ']'); if (l) lbl = l.textContent.toLowerCase(); }
        if (ph.includes(needle) || lbl.includes(needle)) { el = e; break; }
      }
    }
    if (!el) return { found: false };
    el.focus();
    if (el.isContentEditable) { el.textContent = __args.value; }
    else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, __args.value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { found: true, tag: el.tagName.toLowerCase(), name: el.name || null };
  `);
  if (!done.found) throw new Error(`type: champ introuvable ${JSON.stringify({ ref, selector, field })}`);
  if (submit) await page.keyboard.press("Enter");
  return { field: done };
}

// Screenshot PNG encodé base64 (le filesystem du conteneur est inaccessible à
// un agent distant — on renvoie donc l'image directement, pas un chemin).
// Borné dans le temps : Page.captureScreenshot peut se coincer si une autre
// capture (screencast de l'UI) tient le pipeline de rendu — mieux vaut une
// erreur nette qu'un appel qui pend indéfiniment.
export async function screenshot(page, { fullPage = false, timeout = 15000 } = {}) {
  const b64 = await Promise.race([
    page.screenshot({ type: "png", fullPage, encoding: "base64", captureBeyondViewport: fullPage }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("screenshot: capture bloquée (screencast concurrent ?)")), timeout),
    ),
  ]);
  return { mimeType: "image/png", base64: b64 };
}

// Arbre d'accessibilité compact — alternative légère au snapshot quand on ne
// veut que « qu'y a-t-il à l'écran », sans coordonnées.
export async function ax(page) {
  const snap = await page.accessibility.snapshot({ interestingOnly: true });
  const nodes = [];
  (function rec(n) {
    if (!n) return;
    if (n.role && n.role !== "generic" && (n.name || n.value))
      nodes.push({ role: n.role, name: (n.name || "").slice(0, 100), value: n.value || undefined });
    (n.children || []).forEach(rec);
  })(snap);
  return { nodes };
}
