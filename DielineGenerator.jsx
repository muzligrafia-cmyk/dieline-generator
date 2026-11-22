#target illustrator
/*
  DielineGenerator.jsx  v0.2
  15 styles: cartons, trays, corrugated, rigid greyboard, finger-joint boxes.
  All maths in millimetres. The ENGINE section knows nothing about Illustrator,
  so it can be lifted into a standalone app later.

  Laser colours:  green 0,255,0 = cut (outline too, when nothing is cut out inside)
                  pink 255,0,255 = outer cut, only when there are inner cutouts
                  red 255,0,0 = score (bends away from the lasered face)
                  blue 0,0,255 = perforation (bends towards the lasered face)
                  black = marking
*/

var DG_VERSION = "0.2";
var MM = 2.834645669;
var KAPPA = 0.5522847498;

/* ======================================================================
   ENGINE (no Illustrator calls below this line until the next banner)
   ====================================================================== */

function P(x, y) { return { x: x, y: y, ix: x, iy: y, ox: x, oy: y }; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function r2(v) { return Math.round(v * 100) / 100; }
function same(a, b) { return Math.abs(a.x - b.x) < 0.0001 && Math.abs(a.y - b.y) < 0.0001; }

/* Rounded corner at (px,py): arriving along d1, leaving along d2. */
function fillet(px, py, d1x, d1y, d2x, d2y, r) {
    var a = P(px - d1x * r, py - d1y * r);
    a.ox = a.x + d1x * r * KAPPA; a.oy = a.y + d1y * r * KAPPA;
    var b = P(px + d2x * r, py + d2y * r);
    b.ix = b.x - d2x * r * KAPPA; b.iy = b.y - d2y * r * KAPPA;
    return [a, b];
}

/* y' = yBase + sign * y ; optionally reverse travel direction */
function place(nodes, yBase, sign, rev) {
    var out = [], i, n, m;
    for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        m = { x: n.x, y: yBase + sign * n.y, ix: n.ix, iy: yBase + sign * n.iy, ox: n.ox, oy: yBase + sign * n.oy };
        out.push(m);
    }
    if (rev) {
        out.reverse();
        for (i = 0; i < out.length; i++) {
            m = out[i];
            var tx = m.ix, ty = m.iy;
            m.ix = m.ox; m.iy = m.oy; m.ox = tx; m.oy = ty;
        }
    }
    return out;
}

function appendNodes(dst, src) {
    for (var i = 0; i < src.length; i++) {
        var n = src[i];
        if (dst.length > 0 && same(dst[dst.length - 1], n)) {
            dst[dst.length - 1].ox = n.ox; dst[dst.length - 1].oy = n.oy;
        } else {
            dst.push(n);
        }
    }
}

function closeOutline(nodes) {
    if (nodes.length > 1 && same(nodes[0], nodes[nodes.length - 1])) {
        var last = nodes.pop();
        nodes[0].ix = last.ix; nodes[0].iy = last.iy;
    }
    return nodes;
}

function lineNodes(x1, y1, x2, y2) { return [P(x1, y1), P(x2, y2)]; }

/* ---- node helpers ---- */

function mapNodes(nodes, fx, fy) {
    var out = [], i, n;
    for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        out.push({ x: fx(n.x), y: fy(n.y), ix: fx(n.ix), iy: fy(n.iy), ox: fx(n.ox), oy: fy(n.oy) });
    }
    return out;
}
function reverseNodes(nodes) {
    var out = [], i, m;
    for (i = nodes.length - 1; i >= 0; i--) {
        m = nodes[i];
        out.push({ x: m.x, y: m.y, ix: m.ox, iy: m.oy, ox: m.ix, oy: m.iy });
    }
    return out;
}
function shiftNodes(nodes, dx, dy) {
    return mapNodes(nodes, function (x) { return x + dx; }, function (y) { return y + dy; });
}
function flipFeatureX(f, a, b) {
    var fx = function (x) { return a + b - x; }, fy = function (y) { return y; }, i, c;
    f.nodes = reverseNodes(mapNodes(f.nodes, fx, fy));
    for (i = 0; i < f.creases.length; i++) { c = f.creases[i]; c[0] = fx(c[0]); c[2] = fx(c[2]); }
    if (f.glue) { for (i = 0; i < f.glue.length; i++) { for (var j = 0; j < f.glue[i].length; j++) f.glue[i][j][0] = fx(f.glue[i][j][0]); } }
    return f;
}
function roundRect(x, y, w, h, r) {
    var n = [], f;
    f = fillet(x + w, y, 1, 0, 0, 1, r); n.push(f[0], f[1]);
    f = fillet(x + w, y + h, 0, 1, -1, 0, r); n.push(f[0], f[1]);
    f = fillet(x, y + h, -1, 0, 0, -1, r); n.push(f[0], f[1]);
    f = fillet(x, y, 0, -1, 1, 0, r); n.push(f[0], f[1]);
    return n;
}

/* ---- edge features, local frame: travel a -> b along +x, outwards = +y ---- */

function featPlain(a, b) {
    return { nodes: [P(a, 0), P(b, 0)], creases: [] };
}

function featDust(a, b, df, stA, stB, taper) {
    return {
        nodes: [P(a, 0), P(a + stA, 0), P(a + stA + taper, df), P(b - stB - taper, df), P(b - stB, 0), P(b, 0)],
        creases: [[a + stA, 0, b - stB, 0]]
    };
}

function featFlap(a, b, d, inset) {
    return { nodes: [P(a, 0), P(a + inset, d), P(b - inset, d), P(b, 0)], creases: [[a, 0, b, 0]] };
}

function featLid(a, b, ld, td, c, ti, r) {
    var xl = a + c + ti, xr = b - c - ti, top = ld + td;
    var nodes = [P(a, 0), P(a + c, ld), P(xl, ld)];
    var f1 = fillet(xl, top, 0, 1, 1, 0, r);
    var f2 = fillet(xr, top, 1, 0, 0, -1, r);
    nodes.push(f1[0], f1[1], f2[0], f2[1]);
    nodes.push(P(xr, ld), P(b - c, ld), P(b, 0));
    return { nodes: nodes, creases: [[a, 0, b, 0], [xl, ld, xr, ld]] };
}

/* snap-lock (1-2-3) bottom */
function featSnapSide(a, b, ds, dsf, step, backAtB) {
    var um = a + (b - a) * 0.5, nodes = [P(a, 0), P(a + step, 0), P(a + step + 1, ds)];
    if (dsf < ds - 0.5 && um + (ds - dsf) < b - step - 2) {
        nodes.push(P(um, ds), P(um + (ds - dsf), dsf), P(b - step - 1, dsf));
    } else {
        nodes.push(P(b - step - 1, ds));
    }
    nodes.push(P(b - step, 0), P(b, 0));
    var f = { nodes: nodes, creases: [[a + step, 0, b - step, 0]] };
    return backAtB ? flipFeatureX(f, a, b) : f;
}
function featSnapTongue(a, b, d3, tw, tl, step) {
    var xm = (a + b) / 2, tp = tl * 0.25;
    return {
        nodes: [P(a, 0), P(a + step, 0), P(a + step + 1, d3), P(xm - tw / 2, d3), P(xm - tw / 2 + tp, d3 + tl),
                P(xm + tw / 2 - tp, d3 + tl), P(xm + tw / 2, d3), P(b - step - 1, d3), P(b - step, 0), P(b, 0)],
        creases: [[a + step, 0, b - step, 0], [xm - tw / 2, d3, xm + tw / 2, d3]]
    };
}

/* crash-lock (auto) bottom: glue lobe at end a, 45 degree reverse crease */
function featCrashMain(a, b, dA, dB, c) {
    var xm = (a + b) / 2;
    return {
        nodes: [P(a, 0), P(a + c, dA), P(xm, dA), P(xm, dB), P(b - c - dB * 0.12, dB), P(b, 0)],
        creases: [[a, 0, b, 0], [a, 0, a + dA, dA, "valley"]],
        glue: [[[a, 0], [a + c, dA], [a + dA, dA]]]
    };
}
function featCrashSide(a, b, dw, c, step) {
    var f = { nodes: [P(a, 0), P(a + c, dw), P(a + dw + 2, dw), P(b - step, 0), P(b, 0)], creases: [[a, 0, b - step, 0]] };
    return flipFeatureX(f, a, b);   /* glued corner sits at end b */
}

/* ---- result helpers ---- */

function newResult() {
    return { paths: [], labels: [], glue: [], infoPaths: [], warnings: [], lines: [], error: null, bbox: null, title: "" };
}

function addCreases(res, list, yBase, sign) {
    for (var i = 0; i < list.length; i++) {
        var c = list[i];
        res.paths.push({ kind: c[4] || "mountain", closed: false, nodes: lineNodes(c[0], yBase + sign * c[1], c[2], yBase + sign * c[3]) });
    }
}
function addGlue(res, list, yBase, sign) {
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
        var g = [], j;
        for (j = 0; j < list[i].length; j++) g.push([list[i][j][0], yBase + sign * list[i][j][1]]);
        res.glue.push(g);
    }
}
function addLine(res, kind, x1, y1, x2, y2) {
    res.paths.push({ kind: kind, closed: false, nodes: lineNodes(x1, y1, x2, y2) });
}

function computeBBox(res) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, i, j, n, pts;
    for (i = 0; i < res.paths.length; i++) {
        pts = flatten(res.paths[i].nodes, res.paths[i].closed);
        for (j = 0; j < pts.length; j++) {
            n = pts[j];
            if (n[0] < x0) x0 = n[0]; if (n[0] > x1) x1 = n[0];
            if (n[1] < y0) y0 = n[1]; if (n[1] > y1) y1 = n[1];
        }
    }
    res.bbox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function mirrorResult(res) {
    var fx = function (x) { return -x; }, fy = function (y) { return y; }, i, j;
    for (i = 0; i < res.paths.length; i++) {
        res.paths[i].nodes = mapNodes(res.paths[i].nodes, fx, fy);
        if (res.paths[i].kind === "mountain") res.paths[i].kind = "valley";
        else if (res.paths[i].kind === "valley") res.paths[i].kind = "mountain";
    }
    for (i = 0; i < res.labels.length; i++) res.labels[i].x = -res.labels[i].x;
    for (i = 0; i < res.glue.length; i++) for (j = 0; j < res.glue[i].length; j++) res.glue[i][j][0] = -res.glue[i][j][0];
    for (i = 0; i < res.infoPaths.length; i++) for (j = 0; j < res.infoPaths[i].length; j++) res.infoPaths[i][j][0] = -res.infoPaths[i][j][0];
}

/* ---- styles ---- */

var D3 = ["Length (front)", "Width (side)", "Height"];
var STYLES = [
    { id: "rte", name: "Carton: reverse tuck end", fam: "paper", dims: D3, f1: "Glue flap", f2: "Tuck flap", win: true },
    { id: "ste", name: "Carton: straight tuck end", fam: "paper", dims: D3, f1: "Glue flap", f2: "Tuck flap", win: true },
    { id: "snap", name: "Carton: snap-lock bottom (test first)", fam: "paper", dims: D3, f1: "Glue flap", f2: "Tuck flap", win: true },
    { id: "crash", name: "Carton: crash-lock bottom (test first)", fam: "paper", dims: D3, f1: "Glue flap", f2: "Tuck flap", win: true },
    { id: "seal", name: "Carton: seal end (glued flaps)", fam: "paper", dims: D3, f1: "Glue flap", f2: null, win: true },
    { id: "sleeve", name: "Carton: sleeve", fam: "paper", dims: ["Length (front)", "Width (side)", "Sleeve length"], f1: "Glue flap", f2: null, win: true },
    { id: "pillow", name: "Carton: pillow box", fam: "paper", dims: ["Width", "Thickness when closed", "Length"], f1: "Glue flap", f2: null },
    { id: "tray", name: "Tray: glued corners", fam: "paper", dims: ["Length", "Width", "Wall height"], f1: "Corner tab", f2: null },
    { id: "webtray", name: "Tray: web corners (no cuts)", fam: "paper", dims: ["Length", "Width", "Wall height"], f1: null, f2: null },
    { id: "traylid", name: "Tray: base and lid set", fam: "paper", dims: ["Length", "Width", "Base height"], f1: "Corner tab", f2: "Lid height" },
    { id: "rsc", name: "Corrugated: shipping box (0201)", fam: "corr", dims: D3, f1: "Glue flap", f2: null },
    { id: "mailer", name: "Corrugated: mailer (0427, test first)", fam: "corr", dims: ["Length", "Width", "Height"], f1: null, f2: null },
    { id: "rigid", name: "Rigid: base and lid (greyboard)", fam: "rigid", dims: ["Length", "Width", "Base height"], f1: null, f2: "Lid height" },
    { id: "fbox", name: "Plywood: finger-joint box", fam: "wood", dims: ["Length", "Width", "Height"], f1: null, f2: "Finger width", kerf: true },
    { id: "fopen", name: "Plywood: finger-joint box, open top", fam: "wood", dims: ["Length", "Width", "Height"], f1: null, f2: "Finger width", kerf: true }
];
var FAMILY_T = { paper: [0.1, 1.2, 0.4], corr: [1, 8, 1.5], rigid: [1, 5, 2], wood: [1.5, 12, 3] };

function buildDieline(p) {
    var res = newResult();
    if (!(p.L > 0) || !(p.W > 0) || !(p.D > 0)) { res.error = "All three sizes must be above zero."; return res; }
    if (!(p.t > 0)) { res.error = "Board thickness must be above zero."; return res; }
    if (p.t > Math.min(p.L, p.D) / 4) { res.error = "Board is too thick for a box this small."; return res; }
    var s = p.style;
    if (s === "tray" || s === "traylid") buildTrays(p, res);
    else if (s === "webtray") buildWebTray(p, res);
    else if (s === "pillow") buildPillow(p, res);
    else if (s === "mailer") buildMailer(p, res);
    else if (s === "rigid") buildRigid(p, res);
    else if (s === "fbox" || s === "fopen") buildFingerBox(p, res);
    else buildCarton(p, res);
    if (!res.error) {
        if (p.mirror) mirrorResult(res);
        computeBBox(res);
    }
    return res;
}

/* Four panels in a row plus a glue flap. Used by every tube-shaped style. */
function buildCarton(p, res) {
    var t = p.t, s = p.style, corr = (s === "rsc");
    var sgn = (p.dimMode === "inside") ? 1 : -1;
    var cL = p.L + sgn * t, cW = p.W + sgn * t, H = p.D + sgn * (corr ? 2 * t : t);
    if (cL <= 4 * t || cW <= 4 * t || H <= 4 * t) { res.error = "Too small once board thickness is taken off."; return; }

    var p4 = cW - t;
    var gMax = p4 - 1;
    var g = p.glue > 0 ? p.glue : (corr ? clamp(cW * 0.5, 15, 35) : clamp(cW * 0.5, 6, 15));
    if (g > gMax) { if (p.glue > 0) res.warnings.push("Glue flap trimmed to " + r2(gMax) + " mm so it fits behind the side panel."); g = gMax; }
    var gt = Math.min(g * 0.27, H / 4);

    var ld = cW - t;
    var td = p.tuck > 0 ? p.tuck : clamp(cW * 0.6, 8, 20);
    if (td > H - 2) td = H - 2;
    var c = Math.max(t / 2, 0.25), ti = Math.max(t, 0.5);
    var rr = Math.min(td * 0.6, (cL - 2 * c - 2 * ti) / 3);
    var step = t + 0.3;
    var df = Math.min(cL / 2 - 0.5, cW - t);
    var taper = Math.max(1, df * 0.15);
    var needDust = (s === "rte" || s === "ste" || s === "snap" || s === "crash");
    if (needDust && cW - 2 * step - 2 * taper < 3) { res.error = "Side panel is too narrow for dust flaps."; return; }

    var lid = function (a, b) { return featLid(a, b, ld, td, c, ti, rr); };
    var dust = function (a, b) { return featDust(a, b, df, step, step, taper); };
    var plain = function (a, b) { return featPlain(a, b); };
    var top, bot, name;

    if (s === "rte") { name = "Reverse tuck end"; top = [lid, dust, plain, dust]; bot = [plain, dust, lid, dust]; }
    else if (s === "ste") { name = "Straight tuck end"; top = [lid, dust, plain, dust]; bot = [lid, dust, plain, dust]; }
    else if (s === "sleeve") { name = "Sleeve"; top = [plain, plain, plain, plain]; bot = top; }
    else if (s === "seal") {
        name = "Seal end";
        var so = function (a, b) { return featFlap(a, b, cW - 0.5, 0.3); };
        var si = function (a, b) { return featFlap(a, b, cW - t - 0.5, 0.3); };
        var sd = function (a, b) { return featDust(a, b, Math.min(cL / 2 - 0.5, cW - t), step, step, 1); };
        top = [so, sd, si, sd]; bot = top;
        res.lines.push("Outer flap: " + r2(cW - 0.5) + " mm   Inner flap: " + r2(cW - t - 0.5) + " mm");
    }
    else if (s === "snap") {
        name = "Snap-lock bottom";
        var d1 = cW / 2, d3 = cW / 2 - t, tw = cL * 0.5;
        var tl = Math.min(clamp(cW * 0.3, 8, 25), d1 - 2);
        var ds = Math.min(cL / 2 - 0.5, cW * 0.7), dsf = Math.min(ds, (cL - tw) / 2 - 1);
        if (dsf < 3 || tl < 3) { res.error = "Too small for a snap-lock bottom."; return; }
        top = [lid, dust, plain, dust];
        bot = [
            function (a, b) { return featDust(a, b, d1, step, step, 1.5); },
            function (a, b) { return featSnapSide(a, b, ds, dsf, step, false); },
            function (a, b) { return featSnapTongue(a, b, d3, tw, tl, step); },
            function (a, b) { return featSnapSide(a, b, ds, dsf, step, true); }
        ];
        res.lines.push("Bottom: back flap " + r2(d1) + ", tongue " + r2(tw) + " x " + r2(tl) + " mm");
        res.lines.push("Fold order: back flap, both sides, then push the tongue in.");
    }
    else if (s === "crash") {
        name = "Crash-lock bottom";
        var dw = Math.min(cW / 2, cL / 2) - 1, dA = dw, dB = cW - dA - 0.5;
        if (dw < 5) { res.error = "Too small for a crash-lock bottom."; return; }
        top = [lid, dust, plain, dust];
        bot = [
            function (a, b) { return featCrashMain(a, b, dA, dB, c + 0.3); },
            function (a, b) { return featCrashSide(a, b, dw, c + 0.3, step); },
            function (a, b) { return featCrashMain(a, b, dA, dB, c + 0.3); },
            function (a, b) { return featCrashSide(a, b, dw, c + 0.3, step); }
        ];
        res.lines.push("Bottom: glue each shaded triangle to the side flap next to it.");
    }
    else {
        name = "Shipping box 0201";
        var fd = cW / 2, sw = clamp(2 * t, 3, 8) / 2;
        top = [
            function (a, b) { return featDust(a, b, fd, sw, sw, 0); },
            function (a, b) { return featDust(a, b, fd, sw, sw, 0); },
            function (a, b) { return featDust(a, b, fd, sw, sw, 0); },
            function (a, b) { return featDust(a, b, fd, sw, 0, 0); }
        ];
        bot = top;
        res.lines.push("Flaps: " + r2(fd) + " mm   Slots: " + r2(sw * 2) + " mm   Flutes run along the height.");
    }

    var xs = [0, cL, cL + cW, 2 * cL + cW, 2 * cL + cW + p4], xg = -g, outline = [], i, f;
    appendNodes(outline, [P(0, 0), P(xg, gt), P(xg, H - gt), P(0, H)]);
    for (i = 0; i < 4; i++) {
        f = top[i](xs[i], xs[i + 1]);
        appendNodes(outline, place(f.nodes, H, 1, false));
        addCreases(res, f.creases, H, 1); addGlue(res, f.glue, H, 1);
    }
    appendNodes(outline, [P(xs[4], H), P(xs[4], 0)]);
    for (i = 3; i >= 0; i--) {
        f = bot[i](xs[i], xs[i + 1]);
        appendNodes(outline, place(f.nodes, 0, -1, true));
        addCreases(res, f.creases, 0, -1); addGlue(res, f.glue, 0, -1);
    }
    closeOutline(outline);
    for (i = 0; i < 4; i++) addLine(res, "mountain", xs[i], 0, xs[i], H);
    res.paths.push({ kind: "cut", closed: true, nodes: outline });

    /* window on the front panel */
    if (p.winW > 0 && p.winH > 0 && !corr) {
        var ww = Math.min(p.winW, cL - 10), wh = Math.min(p.winH, H - 10);
        if (ww < 3 || wh < 3) res.warnings.push("No room for a window on this front panel.");
        else {
            if (ww < p.winW || wh < p.winH) res.warnings.push("Window trimmed to " + r2(ww) + " x " + r2(wh) + " mm to keep a 5 mm frame.");
            res.paths.push({ kind: "inner", closed: true, nodes: roundRect(xs[2] + (cL - ww) / 2, (H - wh) / 2, ww, wh, Math.min(3, ww / 4, wh / 4)) });
        }
    }

    res.glue.push([[0, 0], [xg, gt], [xg, H - gt], [0, H]]);
    var nm = ["BACK", "SIDE", "FRONT", "SIDE"];
    for (i = 0; i < 4; i++) res.labels.push({ x: (xs[i] + xs[i + 1]) / 2, y: H * 0.72, text: nm[i] });
    res.labels.push({ x: xg / 2, y: H / 2, text: "GLUE" });

    res.title = name + " " + r2(p.L) + " x " + r2(p.W) + " x " + r2(p.D) + " mm (" + p.dimMode + ")";
    res.lines.unshift("Last side panel: " + r2(p4) + " mm   Glue flap: " + r2(g) + " mm");
    res.lines.unshift("Crease to crease: " + r2(cL) + " / " + r2(cW) + " / " + r2(H) + " mm");
    if (needDust) res.lines.push("Lid depth: " + r2(ld) + " mm   Tuck: " + r2(td) + " mm   Dust flap: " + r2(df) + " mm");
    if (needDust && df < cW * 0.4) res.warnings.push("Dust flaps are short because the front is narrow.");
}

function buildPillow(p, res) {
    var t = p.t, cL = p.L, s = p.W / 2, H = p.D;
    if (s > cL / 2.5 || s > H / 3) { res.error = "Too thick for its size: thickness must be under " + r2(Math.min(cL / 1.25, H / 1.5)) + " mm."; return; }
    var g = p.glue > 0 ? p.glue : clamp(cL * 0.2, 8, 15);
    var gt = s + 2, x2 = 2 * cL - t;
    function arc(xa, xb, y, sag) {
        var a = P(xa, y), b = P(xb, y);
        a.ox = xa + (xb - xa) / 3; a.oy = y + sag * 4 / 3;
        b.ix = xb - (xb - xa) / 3; b.iy = y + sag * 4 / 3;
        return [a, b];
    }
    var o = [];
    appendNodes(o, [P(0, 0), P(-g, gt), P(-g, H - gt), P(0, H)]);
    appendNodes(o, arc(0, cL, H, s));
    appendNodes(o, arc(cL, x2, H, s));
    appendNodes(o, [P(x2, H), P(x2, 0)]);
    appendNodes(o, arc(x2, cL, 0, -s));
    appendNodes(o, arc(cL, 0, 0, -s));
    closeOutline(o);
    res.paths.push({ kind: "mountain", closed: false, nodes: arc(0, cL, H, -s) });
    res.paths.push({ kind: "mountain", closed: false, nodes: arc(cL, x2, H, -s) });
    res.paths.push({ kind: "mountain", closed: false, nodes: arc(0, cL, 0, s) });
    res.paths.push({ kind: "mountain", closed: false, nodes: arc(cL, x2, 0, s) });
    addLine(res, "mountain", 0, 0, 0, H); addLine(res, "mountain", cL, 0, cL, H);
    res.paths.push({ kind: "cut", closed: true, nodes: o });
    res.glue.push([[0, 0], [-g, gt], [-g, H - gt], [0, H]]);
    res.title = "Pillow box " + r2(p.L) + " x " + r2(p.W) + " x " + r2(p.D) + " mm";
    res.lines.push("Flat width: " + r2(cL) + " mm   Curve depth: " + r2(s) + " mm   Glue flap: " + r2(g) + " mm");
}

function trayPart(A, B, h, tw, t) {
    var e = t + 0.3, k = Math.min(tw * 0.3, h - e - 2);
    return {
        outline: [
            P(0, -h), P(A, -h), P(A, 0), P(A + e, -tw), P(A + h - k, -tw), P(A + h, 0), P(A + h, B),
            P(A + h - k, B + tw), P(A + e, B + tw), P(A, B), P(A, B + h), P(0, B + h), P(0, B),
            P(-e, B + tw), P(-h + k, B + tw), P(-h, B), P(-h, 0), P(-h + k, -tw), P(-e, -tw), P(0, 0)
        ],
        creases: [[0, 0, A, 0], [A, 0, A, B], [A, B, 0, B], [0, B, 0, 0], [A, 0, A + h, 0], [A, B, A + h, B], [-h, 0, 0, 0], [-h, B, 0, B]],
        glue: [
            [[A, 0], [A + e, -tw], [A + h - k, -tw], [A + h, 0]], [[A + h, B], [A + h - k, B + tw], [A + e, B + tw], [A, B]],
            [[0, B], [-e, B + tw], [-h + k, B + tw], [-h, B]], [[-h, 0], [-h + k, -tw], [-e, -tw], [0, 0]]
        ],
        ok: k >= 0.5
    };
}
function crossPart(A, B, h) {
    return {
        outline: [P(0, -h), P(A, -h), P(A, 0), P(A + h, 0), P(A + h, B), P(A, B), P(A, B + h), P(0, B + h), P(0, B), P(-h, B), P(-h, 0), P(0, 0)],
        creases: [[0, 0, A, 0], [A, 0, A, B], [A, B, 0, B], [0, B, 0, 0]], glue: [], ok: true
    };
}
function addPart(res, part, dx, dy, label, lx, ly) {
    var i, j, c, g;
    for (i = 0; i < part.creases.length; i++) { c = part.creases[i]; addLine(res, c[4] || "mountain", c[0] + dx, c[1] + dy, c[2] + dx, c[3] + dy); }
    res.paths.push({ kind: "cut", closed: true, nodes: shiftNodes(part.outline, dx, dy) });
    for (i = 0; i < part.glue.length; i++) { g = []; for (j = 0; j < part.glue[i].length; j++) g.push([part.glue[i][j][0] + dx, part.glue[i][j][1] + dy]); res.glue.push(g); }
    if (label) res.labels.push({ x: lx + dx, y: ly + dy, text: label });
}

function buildTrays(p, res) {
    var t = p.t, ins = (p.dimMode === "inside"), withLid = (p.style === "traylid");
    var A = p.L + (ins ? t : -t), B = p.W + (ins ? t : -t), h = p.D + (ins ? t / 2 : -t / 2);
    if (A <= 4 * t || B <= 4 * t || h <= 2 * t) { res.error = "Too small once board thickness is taken off."; return; }
    var tw = p.glue > 0 ? p.glue : clamp(h * 0.9, 6, 15);
    if (tw > A / 2 - 1) { tw = A / 2 - 1; if (p.glue > 0) res.warnings.push("Corner tab trimmed to " + r2(tw) + " mm so two tabs do not collide."); }
    var base = trayPart(A, B, h, tw, t);
    if (!base.ok) { res.error = "Walls are too low for corner tabs."; return; }
    addPart(res, base, 0, 0, "BASE", A / 2, B / 2);
    res.title = (withLid ? "Tray with lid " : "Tray ") + r2(p.L) + " x " + r2(p.W) + " x " + r2(p.D) + " mm (" + p.dimMode + ")";
    res.lines.push("Base crease to crease: " + r2(A) + " x " + r2(B) + " mm   Wall: " + r2(h) + " mm   Tab: " + r2(tw) + " mm");
    if (withLid) {
        var cl = t / 2 + 0.25;
        var A2 = A + 2 * t + 2 * cl, B2 = B + 2 * t + 2 * cl;
        var h2 = p.tuck > 0 ? p.tuck : Math.max(10, h * 0.4);
        var tw2 = Math.min(tw, h2 * 0.9, A2 / 2 - 1);
        var lidP = trayPart(A2, B2, h2, tw2, t);
        if (!lidP.ok) { res.error = "Lid is too low for corner tabs, make it taller."; return; }
        addPart(res, lidP, A + h + h2 + 8, 0, "LID", A2 / 2, B2 / 2);
        res.lines.push("Lid crease to crease: " + r2(A2) + " x " + r2(B2) + " mm   Lid wall: " + r2(h2) + " mm");
    }
}

function buildWebTray(p, res) {
    var t = p.t, ins = (p.dimMode === "inside");
    var A = p.L + (ins ? t : -t), B = p.W + (ins ? t : -t), h = p.D + (ins ? t / 2 : -t / 2);
    if (A <= 4 * t || B <= 4 * t || h <= 2 * t) { res.error = "Too small once board thickness is taken off."; return; }
    addLine(res, "mountain", 0, -h, 0, B + h); addLine(res, "mountain", A, -h, A, B + h);
    addLine(res, "mountain", -h, 0, A + h, 0); addLine(res, "mountain", -h, B, A + h, B);
    addLine(res, "valley", 0, 0, -h, -h); addLine(res, "valley", A, 0, A + h, -h);
    addLine(res, "valley", A, B, A + h, B + h); addLine(res, "valley", 0, B, -h, B + h);
    res.paths.push({ kind: "cut", closed: true, nodes: [P(-h, -h), P(A + h, -h), P(A + h, B + h), P(-h, B + h)] });
    res.labels.push({ x: A / 2, y: B / 2, text: "BASE" });
    res.title = "Web-corner tray " + r2(p.L) + " x " + r2(p.W) + " x " + r2(p.D) + " mm (" + p.dimMode + ")";
    res.lines.push("Base crease to crease: " + r2(A) + " x " + r2(B) + " mm   Wall: " + r2(h) + " mm");
    res.lines.push("Corners pinch inwards along the diagonals, then fold flat against a wall.");
}

function buildRigid(p, res) {
    var t = p.t, ins = (p.dimMode === "inside");
    var A = ins ? p.L : p.L - 2 * t, B = ins ? p.W : p.W - 2 * t, h = ins ? p.D : p.D - t;
    if (A <= 2 * t || B <= 2 * t || h <= t) { res.error = "Too small once board thickness is taken off."; return; }
    var cl = 0.75;
    var A2 = A + 2 * t + 2 * cl, B2 = B + 2 * t + 2 * cl;
    var h2 = p.tuck > 0 ? p.tuck : Math.max(10, h * 0.4);
    addPart(res, crossPart(A, B, h), 0, 0, "BASE", A / 2, B / 2);
    addPart(res, crossPart(A2, B2, h2), A + h + h2 + 8, 0, "LID", A2 / 2, B2 / 2);
    res.title = "Rigid box " + r2(p.L) + " x " + r2(p.W) + " x " + r2(p.D) + " mm (" + p.dimMode + ")";
    res.lines.push("Base score to score: " + r2(A) + " x " + r2(B) + " mm   Wall: " + r2(h) + " mm");
    res.lines.push("Lid score to score: " + r2(A2) + " x " + r2(B2) + " mm   Wall: " + r2(h2) + " mm");
    res.lines.push("Scores go on the outside, cut about half way through. Corners stay open for taping or wrapping.");
}

function buildMailer(p, res) {
    var t = p.t, ins = (p.dimMode === "inside");
    var Li = ins ? p.L : p.L - 6 * t, Wi = ins ? p.W : p.W - 2 * t, Hi = ins ? p.D : p.D - 2 * t;
    if (Li < 30 || Wi < 30 || Hi < 3 * t + 6) { res.error = "Too small for a mailer in this board."; return; }
    var A = Li + 5 * t, B = Wi + 2 * t;
    var hw = Hi + t, gap = 2 * t, hi = Hi - 0.5, hf = Hi + t / 2, hb = Hi + t;
    var el = Math.min(B / 2 - 1, Hi * 1.5), tap = Math.min(3, el * 0.2);
    var td = t + 1, tabW = clamp(B * 0.2, 8, 30);
    var yts = (B > 120) ? [B * 0.28, B * 0.72] : [B * 0.5];
    var li = 3 * t, yl0 = B + hb, yl1 = yl0 + B - t / 2;
    var le = Math.min(Hi - t, 40), g2 = 2, tapL = Math.min(le * 0.4, 8);
    var fdp = Hi - t, c = t / 2, r = Math.min(fdp * 0.5, 8);
    var xe = A + hw + gap + hi, e3 = t + 0.3, i;

    var half = [P(A / 2, -hf), P(A, -hf), P(A, -hf + t), P(A + el, -hf + t + tap), P(A + el, -e3 - tap), P(A, -e3), P(A, 0),
                P(A + hw, 0), P(A + hw + gap, e3), P(xe, e3)];
    for (i = 0; i < yts.length; i++) half.push(P(xe, yts[i] - tabW / 2), P(xe + td, yts[i] - tabW / 2 + 1), P(xe + td, yts[i] + tabW / 2 - 1), P(xe, yts[i] + tabW / 2));
    half.push(P(xe, B - e3), P(A + hw + gap, B - e3), P(A + hw, B), P(A, B),
              P(A, B + e3), P(A + el, B + e3 + tap), P(A + el, yl0 - t - tap), P(A, yl0 - t), P(A, yl0),
              P(A - li, yl0), P(A - li, yl0 + g2), P(A - li + le, yl0 + g2 + tapL), P(A - li + le, yl1 - g2 - tapL), P(A - li, yl1 - g2), P(A - li, yl1),
              P(A - li - c, yl1));
    var ff = fillet(A - li - c, yl1 + fdp, 0, 1, -1, 0, r);
    half.push(ff[0], ff[1], P(A / 2, yl1 + fdp));

    var mx = function (x) { return A - x; }, my = function (y) { return y; };
    var outline = [];
    appendNodes(outline, half);
    appendNodes(outline, reverseNodes(mapNodes(half, mx, my)));
    closeOutline(outline);

    var cr = [[A, 0, A, B], [A + hw, 0, A + hw, B], [A + hw + gap, e3, A + hw + gap, B - e3],
              [A, -hf + t, A, -e3], [A, B + e3, A, yl0 - t], [A - li, yl0 + g2, A - li, yl1 - g2]];
    for (i = 0; i < cr.length; i++) {
        addLine(res, "mountain", cr[i][0], cr[i][1], cr[i][2], cr[i][3]);
        addLine(res, "mountain", A - cr[i][0], cr[i][1], A - cr[i][2], cr[i][3]);
    }
    addLine(res, "mountain", 0, 0, A, 0); addLine(res, "mountain", 0, B, A, B);
    addLine(res, "mountain", li, yl0, A - li, yl0); addLine(res, "mountain", li + c, yl1, A - li - c, yl1);
    var sw = t + 0.5, sx = A - 2 * t - sw / 2;
    for (i = 0; i < yts.length; i++) {
        res.paths.push({ kind: "inner", closed: true, nodes: [P(sx, yts[i] - tabW / 2 - 0.5), P(sx + sw, yts[i] - tabW / 2 - 0.5), P(sx + sw, yts[i] + tabW / 2 + 0.5), P(sx, yts[i] + tabW / 2 + 0.5)] });
        res.paths.push({ kind: "inner", closed: true, nodes: [P(A - sx, yts[i] - tabW / 2 - 0.5), P(A - sx - sw, yts[i] - tabW / 2 - 0.5), P(A - sx - sw, yts[i] + tabW / 2 + 0.5), P(A - sx, yts[i] + tabW / 2 + 0.5)] });
    }
    res.paths.push({ kind: "cut", closed: true, nodes: outline });
    res.labels.push({ x: A / 2, y: B / 2, text: "BASE" });
    res.labels.push({ x: A / 2, y: yl0 + (yl1 - yl0) / 2, text: "LID" });
    res.labels.push({ x: A / 2, y: -hf / 2, text: "FRONT" });
    res.title = "Mailer 0427 " + r2(p.L) + " x " + r2(p.W) + " x " + r2(p.D) + " mm (" + p.dimMode + ")";
    res.lines.push("Base crease to crease: " + r2(A) + " x " + r2(B) + " mm   Side wall: " + r2(hw) + " + " + r2(hi) + " mm");
    res.lines.push("Inside space: " + r2(Li) + " x " + r2(Wi) + " x " + r2(Hi) + " mm   Flutes run front to back.");
}

/* ---- finger joints ---- */

function oddCount(len, fw, t) {
    var n = Math.round(len / fw);
    if (n % 2 === 0) n += 1;
    if (n < 3) n = 3;
    while (n > 3 && len / n < 1.5 * t) n -= 2;
    return n;
}
function fingerEdge(len, n, startTab, t, kerf) {
    var depths = [], cuts = [], i, tab;
    for (i = 0; i < n; i++) { tab = ((i % 2 === 0) === startTab); depths.push(tab ? 0 : t); }
    for (i = 1; i < n; i++) cuts.push(i * len / n + (depths[i - 1] === 0 ? kerf / 2 : -kerf / 2));
    return { len: len, depths: depths, cuts: cuts };
}
function plainEdge(len) { return { len: len, depths: [0], cuts: [] }; }

function fingerPanel(Wd, Hd, eB, eR, eT, eL) {
    var edges = [eB, eR, eT, eL], out = [], k, j, e, prev, next, pts, toXY;
    var maps = [
        function (s, d) { return P(s, d); },
        function (s, d) { return P(Wd - d, s); },
        function (s, d) { return P(Wd - s, Hd - d); },
        function (s, d) { return P(d, Hd - s); }
    ];
    for (k = 0; k < 4; k++) {
        e = edges[k]; prev = edges[(k + 3) % 4]; next = edges[(k + 1) % 4]; toXY = maps[k];
        pts = [toXY(prev.depths[prev.depths.length - 1], e.depths[0])];
        for (j = 0; j < e.cuts.length; j++) { pts.push(toXY(e.cuts[j], e.depths[j])); pts.push(toXY(e.cuts[j], e.depths[j + 1])); }
        pts.push(toXY(e.len - next.depths[0], e.depths[e.depths.length - 1]));
        appendNodes(out, pts);
    }
    return closeOutline(out);
}

function buildFingerBox(p, res) {
    var t = p.t, open = (p.style === "fopen"), ins = (p.dimMode === "inside");
    var X = ins ? p.L + 2 * t : p.L, Y = ins ? p.W + 2 * t : p.W, Z = ins ? p.D + (open ? t : 2 * t) : p.D;
    if (Math.min(X, Y, Z) < 6 * t) { res.error = "Every side must be at least six board thicknesses long."; return; }
    var fw = p.tuck > 0 ? p.tuck : Math.max(3 * t, 8);
    var kerf = p.kerf > 0 ? p.kerf : 0;
    var nX = oddCount(X, fw, t), nY = oddCount(Y, fw, t), nZ = oddCount(Z, fw, t);
    function E(len, n, tab) { return fingerEdge(len, n, tab, t, kerf); }
    var fb = fingerPanel(X, Z, E(X, nX, true), E(Z, nZ, true), open ? plainEdge(X) : E(X, nX, true), E(Z, nZ, true));
    var lr = fingerPanel(Y, Z, E(Y, nY, true), E(Z, nZ, false), open ? plainEdge(Y) : E(Y, nY, true), E(Z, nZ, false));
    var tb = fingerPanel(X, Y, E(X, nX, false), E(Y, nY, false), E(X, nX, false), E(Y, nY, false));
    var gap = 5;
    function put(nodes, dx, dy, w, h, label) {
        res.paths.push({ kind: "cut", closed: true, nodes: shiftNodes(nodes, dx, dy) });
        res.labels.push({ x: dx + w / 2, y: dy + h / 2, text: label });
    }
    put(fb, 0, 0, X, Z, "FRONT"); put(fb, X + gap, 0, X, Z, "BACK");
    put(lr, 0, -(Z + gap), Y, Z, "LEFT"); put(lr, Y + gap, -(Z + gap), Y, Z, "RIGHT");
    put(tb, 0, -(Z + gap) - (Y + gap), X, Y, "BOTTOM");
    if (!open) put(tb, X + gap, -(Z + gap) - (Y + gap), X, Y, "TOP");
    res.title = "Finger-joint box" + (open ? ", open top " : " ") + r2(p.L) + " x " + r2(p.W) + " x " + r2(p.D) + " mm (" + p.dimMode + ")";
    res.lines.push("Outside: " + r2(X) + " x " + r2(Y) + " x " + r2(Z) + " mm   Board: " + r2(t) + " mm");
    res.lines.push("Fingers: " + nX + " / " + nY + " / " + nZ + " along length / width / height   Kerf: " + r2(kerf) + " mm");
    if (kerf === 0) res.warnings.push("Kerf is 0, so the joints will be a little loose. Try about 0.15 mm.");
}

/* Turn a node list into plain points (curves become short straight bits). Used by the preview. */
function flatten(nodes, closed) {
    var pts = [], n = nodes.length, i, a, b, s, u, v;
    if (n === 0) return pts;
    pts.push([nodes[0].x, nodes[0].y]);
    var count = closed ? n : n - 1;
    for (i = 0; i < count; i++) {
        a = nodes[i]; b = nodes[(i + 1) % n];
        if (a.ox === a.x && a.oy === a.y && b.ix === b.x && b.iy === b.y) {
            pts.push([b.x, b.y]);
        } else {
            for (s = 1; s <= 8; s++) {
                u = s / 8; v = 1 - u;
                pts.push([
                    v * v * v * a.x + 3 * v * v * u * a.ox + 3 * v * u * u * b.ix + u * u * u * b.x,
                    v * v * v * a.y + 3 * v * v * u * a.oy + 3 * v * u * u * b.iy + u * u * u * b.y
                ]);
            }
        }
    }
    return pts;
}

/* ======================================================================
   ILLUSTRATOR: drawing
   ====================================================================== */

function rgb(r, g, b) { var c = new RGBColor(); c.red = r; c.green = g; c.blue = b; return c; }
function cmyk(c, m, y, k) { var o = new CMYKColor(); o.cyan = c; o.magenta = m; o.yellow = y; o.black = k; return o; }

function spotColor(doc, name, c, m, y, k) {
    var s = null;
    try { s = doc.spots.getByName(name); } catch (e1) { s = null; }
    if (!s) {
        s = doc.spots.add();
        s.name = name;
        s.colorType = ColorModel.SPOT;
        s.color = cmyk(c, m, y, k);
    }
    var sc = new SpotColor();
    sc.spot = s; sc.tint = 100;
    return sc;
}

function addPath(container, nodes, closed, offX, offY, color, widthPt, overprint) {
    var it = container.pathItems.add();
    for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var pp = it.pathPoints.add();
        pp.anchor = [offX + n.x * MM, offY + n.y * MM];
        pp.leftDirection = [offX + n.ix * MM, offY + n.iy * MM];
        pp.rightDirection = [offX + n.ox * MM, offY + n.oy * MM];
        pp.pointType = PointType.CORNER;
    }
    it.closed = closed;
    it.filled = false;
    it.stroked = true;
    it.strokeColor = color;
    it.strokeWidth = widthPt;
    if (overprint) { try { it.strokeOverprint = true; } catch (e) {} }
    return it;
}

function addLabel(layer, text, xPt, yPt, sizePt, color) {
    var tf = layer.textFrames.add();
    tf.contents = text;
    tf.textRange.characterAttributes.size = sizePt;
    tf.textRange.characterAttributes.fillColor = color;
    tf.left = xPt - tf.width / 2;
    tf.top = yPt + tf.height / 2;
    return tf;
}

function drawDieline(res, o) {
    var laser = (o.mode === "laser");
    var space = laser ? DocumentColorSpace.RGB : DocumentColorSpace.CMYK;
    var margin = 15, infoRoom = o.info ? 22 : 0;
    var doc = null, fresh = false;

    if (!o.newDoc && app.documents.length > 0) {
        doc = app.activeDocument;
        if (doc.documentColorSpace != space) {
            if (!confirm("The open document is " + (laser ? "CMYK, but laser files must be RGB." : "RGB, but print shop files should be CMYK.") + "\n\nMake a new document instead?")) return false;
            doc = null;
        }
    }
    if (!doc) {
        doc = app.documents.add(space, (res.bbox.w + 2 * margin) * MM, (res.bbox.h + 2 * margin + infoRoom) * MM);
        fresh = true;
    }

    var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()].artboardRect;
    var cx = (ab[0] + ab[2]) / 2, cy = (ab[1] + ab[3]) / 2 + infoRoom * MM / 2;
    var offX = cx - (res.bbox.x + res.bbox.w / 2) * MM;
    var offY = cy - (res.bbox.y + res.bbox.h / 2) * MM;

    var colCut, colInner, colMount, colValley, colInfo, colGlue, sw;
    if (laser) {
        var hasInner = false;
        for (var q = 0; q < res.paths.length; q++) { if (res.paths[q].kind === "inner") hasInner = true; }
        /* outline is green unless there are inner cutouts; then inner = green, outline = pink */
        colCut = hasInner ? rgb(255, 0, 255) : rgb(0, 255, 0); colInner = rgb(0, 255, 0);
        colMount = rgb(255, 0, 0); colValley = rgb(0, 0, 255);
        colInfo = rgb(0, 0, 0); colGlue = rgb(0, 0, 0);
        sw = 0.25;
    } else {
        colCut = spotColor(doc, "Cut", 0, 100, 0, 0);
        colInner = colCut;
        colMount = spotColor(doc, "Crease", 100, 0, 0, 0);
        colValley = colMount;
        colInfo = cmyk(0, 0, 0, 60); colGlue = cmyk(0, 0, 0, 60);
        sw = 0.5;
    }

    var infoLayer = null, dieLayer, i, j;
    if (o.info) {
        if (fresh) infoLayer = doc.layers[0]; else infoLayer = doc.layers.add();
        infoLayer.name = "Dieline info (not for cutting)";
        try { infoLayer.printable = false; } catch (e2) {}
    }
    if (fresh && !o.info) dieLayer = doc.layers[0]; else dieLayer = doc.layers.add();
    dieLayer.name = "Dieline";

    var grp = dieLayer.groupItems.add();
    grp.name = res.title;
    var order = ["mountain", "valley", "inner", "cut"];
    for (j = 0; j < order.length; j++) {
        for (i = 0; i < res.paths.length; i++) {
            var pa = res.paths[i];
            if (pa.kind !== order[j]) continue;
            var col = pa.kind === "cut" ? colCut : (pa.kind === "inner" ? colInner : (pa.kind === "valley" ? colValley : colMount));
            addPath(grp, pa.nodes, pa.closed, offX, offY, col, sw, !laser);
        }
    }

    if (o.info) {
        var ig = infoLayer.groupItems.add();
        ig.name = "Info";
        for (i = 0; i < res.glue.length; i++) {
            var gp = res.glue[i], nodes = [];
            for (j = 0; j < gp.length; j++) nodes.push(P(gp[j][0], gp[j][1]));
            var gi = addPath(ig, nodes, true, offX, offY, colGlue, sw, false);
            gi.stroked = false; gi.filled = true; gi.fillColor = colGlue; gi.opacity = 20;
        }
        for (i = 0; i < res.infoPaths.length; i++) {
            var ip = res.infoPaths[i], n2 = [];
            for (j = 0; j < ip.length; j++) n2.push(P(ip[j][0], ip[j][1]));
            addPath(ig, n2, false, offX, offY, colInfo, 0.5, false);
        }
        for (i = 0; i < res.labels.length; i++) {
            var lb = res.labels[i];
            addLabel(infoLayer, lb.text, offX + lb.x * MM, offY + lb.y * MM, 7, colInfo);
        }
        var block = res.title + "\r" + "Board " + r2(o.t) + " mm   " + res.lines.join("   ") + "\r" + "Flat size " + r2(res.bbox.w) + " x " + r2(res.bbox.h) + " mm";
        addLabel(infoLayer, block, offX + (res.bbox.x + res.bbox.w / 2) * MM, offY + (res.bbox.y - 12) * MM, 7, colInfo);
    }
    return true;
}

/* ======================================================================
   ILLUSTRATOR: dialog
   ====================================================================== */

function num(s) {
    var v = parseFloat(String(s).replace(",", "."));
    return isNaN(v) ? 0 : v;
}

function settingsFile() { return new File(Folder.userData + "/DielineGenerator_settings.txt"); }

function loadSettings() {
    var s = {};
    try {
        var f = settingsFile();
        if (f.exists && f.open("r")) {
            while (!f.eof) {
                var ln = f.readln(), k = ln.indexOf("=");
                if (k > 0) s[ln.substring(0, k)] = ln.substring(k + 1);
            }
            f.close();
        }
    } catch (e) {}
    return s;
}

function saveSettings(s) {
    try {
        var f = settingsFile();
        if (f.open("w")) {
            for (var k in s) { if (s.hasOwnProperty(k)) f.writeln(k + "=" + s[k]); }
            f.close();
        }
    } catch (e) {}
}

function bigFont(el, size) {
    try { el.graphics.font = ScriptUI.newFont(el.graphics.font.name, "REGULAR", size); } catch (e) {}
    if (el.children) { for (var i = 0; i < el.children.length; i++) bigFont(el.children[i], size); }
}

function showDialog() {
    var saved = loadSettings();
    var current = null, lastFam = null;

    var w = new Window("dialog", "Dieline Generator " + DG_VERSION);
    w.orientation = "row";
    w.alignChildren = ["fill", "top"];
    w.spacing = 14;

    function column() {
        var g = w.add("group");
        g.orientation = "column"; g.alignChildren = ["fill", "top"]; g.spacing = 10;
        return g;
    }
    function panel(parent, title) {
        var pn = parent.add("panel", undefined, title);
        pn.alignChildren = ["fill", "top"]; pn.margins = 14;
        return pn;
    }
    function row(parent, label, value) {
        var g = parent.add("group");
        g.orientation = "row";
        var st = g.add("statictext", undefined, label);
        st.preferredSize = [165, 26];
        var et = g.add("edittext", undefined, value);
        et.preferredSize = [80, 30];
        g.add("statictext", undefined, "mm");
        return { label: st, field: et, group: g };
    }

    var col1 = column(), col2 = column(), right = column();
    var names = [], i;
    for (i = 0; i < STYLES.length; i++) names.push(STYLES[i].name);

    var pStyle = panel(col1, "Box style");
    var ddStyle = pStyle.add("dropdownlist", undefined, names);
    ddStyle.preferredSize = [300, 32];

    var pDim = panel(col1, "Dimensions");
    var gMode = pDim.add("group");
    var rbIn = gMode.add("radiobutton", undefined, "Inside size");
    var rbOut = gMode.add("radiobutton", undefined, "Outside size");
    var rL = row(pDim, "Length", saved.L || "60");
    var rW = row(pDim, "Width", saved.W || "40");
    var rD = row(pDim, "Height", saved.D || "100");

    var pMat = panel(col1, "Board");
    var presets = [["Custom thickness", 0], ["Paperboard 250 gsm, about 0.35 mm", 0.35], ["Paperboard 300 gsm, about 0.40 mm", 0.40],
                   ["Paperboard 350 gsm, about 0.50 mm", 0.50], ["Paperboard 400 gsm, about 0.60 mm", 0.60],
                   ["Corrugated E flute, about 1.5 mm", 1.5], ["Corrugated B flute, about 3 mm", 3], ["Corrugated C flute, about 4 mm", 4],
                   ["Greyboard 1.5 mm", 1.5], ["Greyboard 2 mm", 2], ["Plywood or acrylic 3 mm", 3], ["Plywood or acrylic 4 mm", 4]];
    var pn2 = [];
    for (i = 0; i < presets.length; i++) pn2.push(presets[i][0]);
    var ddMat = pMat.add("dropdownlist", undefined, pn2);
    ddMat.preferredSize = [300, 32];
    var rT = row(pMat, "Thickness", saved.t || "0.4");

    var pFlap = panel(col2, "Flaps and details (0 = automatic)");
    var rG = row(pFlap, "Glue flap", saved.glue || "0");
    var rK = row(pFlap, "Tuck flap", saved.tuck || "0");

    var pExtra = panel(col2, "Extras (0 = none)");
    var rWW = row(pExtra, "Window width", saved.winW || "0");
    var rWH = row(pExtra, "Window height", saved.winH || "0");
    var rKerf = row(pExtra, "Laser kerf", saved.kerf || "0");
    var cbMirror = pExtra.add("checkbox", undefined, "Mirror (inside face up)");

    var pOut = panel(col2, "Output");
    pOut.alignChildren = ["left", "top"];
    var rbLaser = pOut.add("radiobutton", undefined, "Laser (RGB)");
    var rbPrint = pOut.add("radiobutton", undefined, "Print shop (spot colours)");
    var gDoc = pOut.add("group");
    var rbNew = gDoc.add("radiobutton", undefined, "New document");
    var rbCur = gDoc.add("radiobutton", undefined, "Current");
    var cbInfo = pOut.add("checkbox", undefined, "Labels and notes layer");

    var pv = right.add("panel");
    pv.preferredSize = [460, 430];
    var readout = right.add("statictext", undefined, "", { multiline: true });
    readout.preferredSize = [460, 150];
    var gBtn = right.add("group");
    gBtn.alignment = ["right", "bottom"];
    var bClose = gBtn.add("button", undefined, "Close", { name: "cancel" });
    var bDraw = gBtn.add("button", undefined, "Draw it", { name: "ok" });
    bClose.preferredSize = [130, 40];
    bDraw.preferredSize = [170, 40];

    /* restore */
    var si = 0;
    for (i = 0; i < STYLES.length; i++) { if (STYLES[i].id === saved.styleId) si = i; }
    ddStyle.selection = si;
    lastFam = STYLES[si].fam;
    ddMat.selection = 0;
    if (saved.dimMode === "outside") rbOut.value = true; else rbIn.value = true;
    if (saved.mode === "print") rbPrint.value = true; else rbLaser.value = true;
    if (saved.newDoc === "0" && app.documents.length > 0) rbCur.value = true; else rbNew.value = true;
    if (app.documents.length === 0) rbCur.enabled = false;
    cbInfo.value = (saved.info === "1") || (saved.info === undefined && rbPrint.value);
    cbMirror.value = (saved.mirror === "1");

    function params() {
        return {
            style: STYLES[ddStyle.selection.index].id,
            L: num(rL.field.text), W: num(rW.field.text), D: num(rD.field.text),
            t: num(rT.field.text),
            dimMode: rbOut.value ? "outside" : "inside",
            glue: num(rG.field.text), tuck: num(rK.field.text),
            winW: num(rWW.field.text), winH: num(rWH.field.text), kerf: num(rKerf.field.text),
            mirror: cbMirror.value
        };
    }

    function refresh() {
        var st = STYLES[ddStyle.selection.index];
        rL.label.text = st.dims[0]; rW.label.text = st.dims[1]; rD.label.text = st.dims[2];
        rG.label.text = st.f1 || "Glue flap"; rG.field.enabled = !!st.f1;
        rK.label.text = st.f2 || "Tuck flap"; rK.field.enabled = !!st.f2;
        rWW.field.enabled = !!st.win; rWH.field.enabled = !!st.win;
        rKerf.field.enabled = !!st.kerf;
        current = buildDieline(params());
        var txt;
        if (current.error) {
            txt = "Cannot build this box:\n" + current.error;
        } else {
            txt = "Flat size: " + r2(current.bbox.w) + " x " + r2(current.bbox.h) + " mm\n" + current.lines.join("\n");
            if (current.warnings.length) txt += "\n! " + current.warnings.join("\n! ");
        }
        readout.text = txt;
        bDraw.enabled = !current.error;
        try { pv.visible = false; pv.visible = true; } catch (e) {}
    }

    function styleChanged() {
        var st = STYLES[ddStyle.selection.index];
        if (st.fam !== lastFam) {
            var rng = FAMILY_T[st.fam], tv = num(rT.field.text);
            if (tv < rng[0] || tv > rng[1]) { rT.field.text = String(rng[2]); ddMat.selection = 0; }
            if (st.fam !== "paper" && num(rL.field.text) < 80) { rL.field.text = "200"; rW.field.text = "150"; rD.field.text = "80"; }
            lastFam = st.fam;
        }
        refresh();
    }

    pv.onDraw = function () {
        var g = this.graphics;
        var W = this.size[0], H = this.size[1];
        g.newPath();
        g.rectPath(0, 0, W, H);
        g.fillPath(g.newBrush(g.BrushType.SOLID_COLOR, [0.13, 0.13, 0.14, 1]));
        if (!current || current.error || !current.bbox) return;
        var bb = current.bbox, pad = 22;
        var sc = Math.min((W - 2 * pad) / bb.w, (H - 2 * pad) / bb.h);
        var ox = (W - bb.w * sc) / 2, oy = (H - bb.h * sc) / 2;
        var pvInner = false, z;
        for (z = 0; z < current.paths.length; z++) { if (current.paths[z].kind === "inner") pvInner = true; }
        var pens = {
            cut: g.newPen(g.PenType.SOLID_COLOR, pvInner ? [1, 0.25, 1, 1] : [0.2, 1, 0.2, 1], 2),
            inner: g.newPen(g.PenType.SOLID_COLOR, [0.2, 1, 0.2, 1], 2),
            mountain: g.newPen(g.PenType.SOLID_COLOR, [1, 0.3, 0.3, 1], 1),
            valley: g.newPen(g.PenType.SOLID_COLOR, [0.4, 0.6, 1, 1], 1)
        };
        var order = ["mountain", "valley", "inner", "cut"], a, b, k;
        for (a = 0; a < order.length; a++) {
            for (b = 0; b < current.paths.length; b++) {
                var pa = current.paths[b];
                if (pa.kind !== order[a]) continue;
                var pts = flatten(pa.nodes, pa.closed);
                g.newPath();
                g.moveTo(ox + (pts[0][0] - bb.x) * sc, oy + (bb.y + bb.h - pts[0][1]) * sc);
                for (k = 1; k < pts.length; k++) g.lineTo(ox + (pts[k][0] - bb.x) * sc, oy + (bb.y + bb.h - pts[k][1]) * sc);
                g.strokePath(pens[pa.kind]);
            }
        }
    };

    var fields = [rL.field, rW.field, rD.field, rG.field, rK.field, rWW.field, rWH.field, rKerf.field];
    for (i = 0; i < fields.length; i++) fields[i].onChanging = refresh;
    rT.field.onChanging = function () { ddMat.selection = 0; refresh(); };
    ddStyle.onChange = styleChanged;
    ddMat.onChange = function () {
        var v = presets[ddMat.selection.index][1];
        if (v > 0) { rT.field.text = String(v); refresh(); }
    };
    rbIn.onClick = refresh; rbOut.onClick = refresh; cbMirror.onClick = refresh;
    rbLaser.onClick = function () { cbInfo.value = false; };
    rbPrint.onClick = function () { cbInfo.value = true; };

    bigFont(w, 15);
    w.onShow = refresh;

    if (w.show() !== 1) return null;

    var p = params();
    var out = { params: p, mode: rbPrint.value ? "print" : "laser", newDoc: rbNew.value, info: cbInfo.value, t: p.t };
    saveSettings({
        styleId: p.style, L: rL.field.text, W: rW.field.text, D: rD.field.text, t: rT.field.text,
        glue: rG.field.text, tuck: rK.field.text, winW: rWW.field.text, winH: rWH.field.text, kerf: rKerf.field.text,
        mirror: p.mirror ? "1" : "0", dimMode: p.dimMode, mode: out.mode,
        newDoc: out.newDoc ? "1" : "0", info: out.info ? "1" : "0"
    });
    return out;
}

function main() {
    var o = showDialog();
    if (!o) return;
    var res = buildDieline(o.params);
    if (res.error) { alert(res.error); return; }
    try {
        drawDieline(res, o);
    } catch (e) {
        alert("Something went wrong while drawing:\n" + e + (e.line ? "\n(line " + e.line + ")" : ""));
    }
}

if (typeof app !== "undefined" && app.name && String(app.name).indexOf("Illustrator") >= 0) main();
