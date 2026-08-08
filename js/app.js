
        "use strict";
        const SVGNS = "http://www.w3.org/2000/svg";
        const $ = id => document.getElementById(id);
        const stage = $("stage");

        // ---------------- geometry helpers (hole-punched fills) ----------------
        // hidden svg used purely to measure path bounding boxes off-screen
        const measureSVG = document.createElementNS(SVGNS, "svg");
        measureSVG.setAttribute("width", "0"); measureSVG.setAttribute("height", "0");
        measureSVG.style.position = "absolute"; measureSVG.style.visibility = "hidden"; measureSVG.style.pointerEvents = "none";
        document.body.appendChild(measureSVG);
        const measurePath = document.createElementNS(SVGNS, "path");
        measureSVG.appendChild(measurePath);
        function getPathBBox(d) {
            if (!d) return { x: 0, y: 0, width: 0, height: 0 };
            measurePath.setAttribute("d", d);
            try { return measurePath.getBBox(); } catch { return { x: 0, y: 0, width: 0, height: 0 }; }
        }
        function bboxOverlap(a, b) {
            return !(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
        }
        // for each path, the list of paths drawn *on top of it* (later in stacking
        // order) whose bounding box overlaps it — those toppers punch a hole in
        // this path's fill, whether or not the topper itself is filled. So a small
        // shape sitting inside a big one keeps the big shape's color out of its
        // area until the small shape gets its own fill turned on.
        function computeToppers(paths) {
            const boxes = paths.map(p => getPathBBox(p.d));
            return paths.map((p, i) => paths.filter((q, j) => j > i && bboxOverlap(boxes[i], boxes[j])));
        }

        // ---------------- state ----------------
        const S = {
            tool: "pen",
            paths: [],           // {id, d, stroke, strokeWidth, fill, closed, type}
            selected: null,
            view: { x: 0, y: 0, w: 1000, h: 700 },
            baseW: 1000,
            canvasW: 1000, canvasH: 700,
            img: null,           // {href, w, h}
            imgOpacity: .55, imgVisible: true,
            style: { stroke: "#1b1e27", strokeWidth: 2, fill: "#3dd7c0", fillOn: false, closeByDefault: false },
            pen: { active: false, anchors: [], dragging: null, dragStart: null },
            free: { active: false, pts: [] },
            pan: { active: false, sx: 0, sy: 0, vx: 0, vy: 0 },
            drag: { active: false, id: null, sx: 0, sy: 0, base: null }, // move selected path
            history: [], redo: [],
            idc: 1,
        };
        const round = n => Math.round(n * 100) / 100;
        const uid = () => "p" + (S.idc++);

        // ---------------- persistent svg layers ----------------
        let elPaper, elGrid, elImg, elArt, elOverlay, elMaskDefs, gridPattern;
        function buildStage() {
            stage.innerHTML = "";
            const defs = document.createElementNS(SVGNS, "defs");
            gridPattern = document.createElementNS(SVGNS, "pattern");
            gridPattern.setAttribute("id", "grid");
            gridPattern.setAttribute("patternUnits", "userSpaceOnUse");
            gridPattern.setAttribute("width", "40"); gridPattern.setAttribute("height", "40");
            const gp = document.createElementNS(SVGNS, "path");
            gp.setAttribute("d", "M40 0H0V40");
            gp.setAttribute("fill", "none");
            gp.setAttribute("stroke", "#000"); gp.setAttribute("stroke-opacity", "0.05"); gp.setAttribute("stroke-width", "1");
            gridPattern.appendChild(gp); defs.appendChild(gridPattern); stage.appendChild(defs);

            elPaper = rect(0, 0, S.canvasW, S.canvasH, "var(--paper)"); elPaper.setAttribute("class", "paper"); stage.appendChild(elPaper);
            elGrid = rect(0, 0, S.canvasW, S.canvasH, "url(#grid)"); stage.appendChild(elGrid);
            elImg = document.createElementNS(SVGNS, "image"); elImg.setAttribute("x", "0"); elImg.setAttribute("y", "0"); stage.appendChild(elImg);
            elMaskDefs = document.createElementNS(SVGNS, "defs"); stage.appendChild(elMaskDefs);
            elArt = document.createElementNS(SVGNS, "g"); stage.appendChild(elArt);
            elOverlay = document.createElementNS(SVGNS, "g"); stage.appendChild(elOverlay);
            applyImg(); applyView();
        }
        function rect(x, y, w, h, fill) {
            const r = document.createElementNS(SVGNS, "rect");
            r.setAttribute("x", x); r.setAttribute("y", y); r.setAttribute("width", w); r.setAttribute("height", h);
            r.setAttribute("fill", fill); return r;
        }
        function applyView() {
            const v = S.view;
            stage.setAttribute("viewBox", `${round(v.x)} ${round(v.y)} ${round(v.w)} ${round(v.h)}`);
            stage.setAttribute("preserveAspectRatio", "xMidYMid meet");
            renderOverlay();
            $("stZoom").textContent = Math.round(S.baseW / v.w * 100) + "%";
        }
        function applyImg() {
            if (S.img) {
                elImg.setAttribute("href", S.img.href);
                elImg.setAttribute("width", S.img.w); elImg.setAttribute("height", S.img.h);
                elImg.style.display = S.imgVisible ? "" : "none";
                elImg.setAttribute("opacity", S.imgOpacity);
            } else { elImg.style.display = "none"; }
        }

        // screen -> svg coordinates
        function toSVG(evt) {
            const pt = stage.createSVGPoint();
            pt.x = evt.clientX; pt.y = evt.clientY;
            const m = stage.getScreenCTM();
            if (!m) return { x: 0, y: 0 };
            const p = pt.matrixTransform(m.inverse());
            return { x: p.x, y: p.y };
        }
        function pxScale() { // svg-units per screen-pixel (for constant-size handles)
            const r = stage.getBoundingClientRect();
            const scale = S.view.h / r.height;
            return scale || 1;
        }

        // ---------------- path building ----------------
        function penD(anchors, closed) {
            if (!anchors.length) return "";
            const f = n => round(n);
            const seg = (p, c) => {
                const hasOut = !!p.hOut, hasIn = !!c.hIn;
                if (!hasOut && !hasIn) return ` L ${f(c.x)} ${f(c.y)}`;
                const c1 = hasOut ? p.hOut : { x: p.x, y: p.y };
                const c2 = hasIn ? c.hIn : { x: c.x, y: c.y };
                return ` C ${f(c1.x)} ${f(c1.y)} ${f(c2.x)} ${f(c2.y)} ${f(c.x)} ${f(c.y)}`;
            };
            let d = `M ${f(anchors[0].x)} ${f(anchors[0].y)}`;
            for (let i = 1; i < anchors.length; i++) d += seg(anchors[i - 1], anchors[i]);
            if (closed && anchors.length > 1) { d += seg(anchors[anchors.length - 1], anchors[0]); d += " Z"; }
            return d;
        }
        function rdp(pts, eps) {
            if (pts.length < 3) return pts.slice();
            const a = pts[0], b = pts[pts.length - 1];
            let dmax = 0, idx = 0;
            const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
            for (let i = 1; i < pts.length - 1; i++) {
                const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / len;
                if (d > dmax) { dmax = d; idx = i; }
            }
            if (dmax > eps) {
                const l = rdp(pts.slice(0, idx + 1), eps);
                const r = rdp(pts.slice(idx), eps);
                return l.slice(0, -1).concat(r);
            }
            return [a, b];
        }
        function smoothD(pts) {
            const f = n => round(n);
            if (pts.length < 2) return "";
            if (pts.length === 2) return `M ${f(pts[0].x)} ${f(pts[0].y)} L ${f(pts[1].x)} ${f(pts[1].y)}`;
            let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
                const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
                const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
                d += ` C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2.x)} ${f(p2.y)}`;
            }
            return d;
        }

        // ---------------- history ----------------
        function snapshot() { return JSON.stringify(S.paths); }
        function pushHistory() { S.history.push(snapshot()); if (S.history.length > 60) S.history.shift(); S.redo.length = 0; }
        function undo() {
            if (S.pen.active) { // undo last anchor first
                if (S.pen.anchors.length) { S.pen.anchors.pop(); if (!S.pen.anchors.length) S.pen.active = false; renderOverlay(); return; }
            }
            if (!S.history.length) { toast("Nothing to undo"); return; }
            S.redo.push(snapshot());
            S.paths = JSON.parse(S.history.pop());
            S.selected = null;
            renderArt(); renderLayers();
        }

        // ---------------- rendering ----------------
        function renderArt() {
            elArt.innerHTML = "";
            elMaskDefs.innerHTML = "";
            const toppersByPath = computeToppers(S.paths);
            S.paths.forEach((p, i) => {
                const hasFill = p.fill && p.fill !== "none";
                const toppers = toppersByPath[i];

                // fill layer — any shape drawn on top of this one punches a hole in
                // its fill (regardless of whether that shape has fill itself), so a
                // small shape sitting inside a bigger filled one stays uncolored
                // until you turn its own fill on
                if (hasFill) {
                    const fillEl = document.createElementNS(SVGNS, "path");
                    fillEl.setAttribute("d", p.d);
                    fillEl.setAttribute("fill", p.fill);
                    fillEl.setAttribute("stroke", "none");
                    fillEl.setAttribute("pointer-events", "none");
                    if (toppers.length) {
                        const maskId = "mask-" + p.id;
                        const mask = document.createElementNS(SVGNS, "mask");
                        mask.setAttribute("id", maskId);
                        mask.setAttribute("maskUnits", "userSpaceOnUse");
                        const base = document.createElementNS(SVGNS, "path");
                        base.setAttribute("d", p.d);
                        base.setAttribute("fill", "white");
                        mask.appendChild(base);
                        for (const t of toppers) {
                            const hole = document.createElementNS(SVGNS, "path");
                            hole.setAttribute("d", t.d);
                            hole.setAttribute("fill", "black");
                            mask.appendChild(hole);
                        }
                        elMaskDefs.appendChild(mask);
                        fillEl.setAttribute("mask", `url(#${maskId})`);
                    }
                    elArt.appendChild(fillEl);
                }

                // stroke layer — always the full outline, never clipped
                if (p.stroke && p.stroke !== "none") {
                    const strokeEl = document.createElementNS(SVGNS, "path");
                    strokeEl.setAttribute("d", p.d);
                    strokeEl.setAttribute("fill", "none");
                    strokeEl.setAttribute("stroke", p.stroke);
                    strokeEl.setAttribute("stroke-width", p.strokeWidth);
                    strokeEl.setAttribute("stroke-linecap", "round");
                    strokeEl.setAttribute("stroke-linejoin", "round");
                    strokeEl.setAttribute("pointer-events", "none");
                    elArt.appendChild(strokeEl);
                }

                // invisible hit layer — keeps click/select behavior identical to the
                // old single-element render, regardless of how the fill is clipped
                const hitEl = document.createElementNS(SVGNS, "path");
                hitEl.setAttribute("d", p.d);
                hitEl.setAttribute("fill", hasFill ? "transparent" : "none");
                hitEl.setAttribute("stroke", "transparent");
                hitEl.setAttribute("stroke-width", p.strokeWidth || 0);
                hitEl.dataset.id = p.id;
                hitEl.style.cursor = S.tool === "select" ? "move" : "";
                elArt.appendChild(hitEl);
            });
            updatePathCount();
        }
        function renderOverlay() {
            elOverlay.innerHTML = "";
            const sc = pxScale();
            // selection outline
            if (S.selected) {
                const p = S.paths.find(x => x.id === S.selected);
                if (p) {
                    const o = document.createElementNS(SVGNS, "path");
                    o.setAttribute("d", p.d); o.setAttribute("class", "sel-outline");
                    o.setAttribute("stroke-width", 1.4 * sc);
                    elOverlay.appendChild(o);
                }
            }
            // pen preview
            if (S.pen.active && S.pen.anchors.length) {
                const a = S.pen.anchors;
                const prev = document.createElementNS(SVGNS, "path");
                prev.setAttribute("class", "preview-path");
                prev.setAttribute("d", penD(a, false));
                prev.setAttribute("stroke-width", Math.max(S.style.strokeWidth, 1.2 * sc));
                elOverlay.appendChild(prev);
                // rubber band to cursor
                if (S.hover) {
                    const rb = document.createElementNS(SVGNS, "path");
                    rb.setAttribute("class", "rubber"); rb.setAttribute("stroke-width", 1.2 * sc);
                    const last = a[a.length - 1];
                    rb.setAttribute("d", `M ${round(last.x)} ${round(last.y)} L ${round(S.hover.x)} ${round(S.hover.y)}`);
                    elOverlay.appendChild(rb);
                }
                // handles + anchors
                a.forEach((an, i) => {
                    [["hIn", an.hIn], ["hOut", an.hOut]].forEach(([k, h]) => {
                        if (!h) return;
                        const ln = document.createElementNS(SVGNS, "line");
                        ln.setAttribute("x1", an.x); ln.setAttribute("y1", an.y);
                        ln.setAttribute("x2", h.x); ln.setAttribute("y2", h.y);
                        ln.setAttribute("class", "handle-line"); ln.setAttribute("stroke-width", 1 * sc);
                        elOverlay.appendChild(ln);
                        const hd = document.createElementNS(SVGNS, "circle");
                        hd.setAttribute("cx", h.x); hd.setAttribute("cy", h.y); hd.setAttribute("r", 3 * sc);
                        hd.setAttribute("class", "handle-dot"); elOverlay.appendChild(hd);
                    });
                    const c = document.createElementNS(SVGNS, "circle");
                    c.setAttribute("cx", an.x); c.setAttribute("cy", an.y); c.setAttribute("r", (i === 0 ? 4.5 : 3.8) * sc);
                    c.setAttribute("stroke-width", 1.8 * sc);
                    c.setAttribute("class", "anchor" + (i === 0 ? " first" : ""));
                    elOverlay.appendChild(c);
                });
            }
        }
        function updatePathCount() { $("pathCount").textContent = S.paths.length; }

        function renderLayers() {
            const wrap = $("layers");
            if (!S.paths.length) {
                wrap.innerHTML = '<div class="empty-layers">No paths yet.<br>Pick the Pen and start clicking on the canvas.</div>';
                updatePathCount(); return;
            }
            wrap.innerHTML = "";
            S.paths.forEach((p, i) => {
                const row = document.createElement("div");
                row.className = "layer" + (p.id === S.selected ? " sel" : "");
                row.innerHTML =
                    `<span class="chip" style="background:${p.fill && p.fill !== 'none' ? p.fill : p.stroke}"></span>
       <span class="lname">Path ${i + 1}</span>
       <span class="ltype">${p.type}</span>
       <button class="del" title="Delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg></button>`;
                row.addEventListener("click", e => {
                    if (e.target.closest(".del")) return;
                    selectPath(p.id);
                });
                row.querySelector(".del").addEventListener("click", e => { e.stopPropagation(); deletePath(p.id); });
                wrap.appendChild(row);
            });
            updatePathCount();
        }

        // ---------------- path ops ----------------
        function commitPath(d, type) {
            if (!d) return;
            pushHistory();
            const p = {
                id: uid(), d, type,
                stroke: S.style.stroke,
                strokeWidth: S.style.strokeWidth,
                fill: S.style.fillOn ? S.style.fill : "none",
                closed: false,
            };
            S.paths.push(p);
            renderArt(); renderLayers();
        }
        function selectPath(id) {
            S.selected = id;
            const p = S.paths.find(x => x.id === id);
            if (p) loadStyleFromPath(p);
            renderLayers(); renderOverlay();
            setTool("select");
        }
        function deletePath(id) {
            pushHistory();
            S.paths = S.paths.filter(x => x.id !== id);
            if (S.selected === id) S.selected = null;
            renderArt(); renderLayers(); renderOverlay();
        }
        function loadStyleFromPath(p) {
            S.style.stroke = p.stroke;
            S.style.strokeWidth = p.strokeWidth;
            S.style.fillOn = p.fill && p.fill !== "none";
            if (S.style.fillOn) S.style.fill = p.fill;
            syncStyleUI();
        }
        function applyStyleToSelected() {
            if (!S.selected) return;
            const p = S.paths.find(x => x.id === S.selected);
            if (!p) return;
            p.stroke = S.style.stroke;
            p.strokeWidth = S.style.strokeWidth;
            p.fill = S.style.fillOn ? S.style.fill : "none";
            renderArt(); renderLayers(); renderOverlay();
        }

        // ---------------- pen tool ----------------
        function penDown(pt, evt) {
            const sc = pxScale();
            const a = S.pen.anchors;
            // close if clicking near first anchor
            if (S.pen.active && a.length > 2) {
                const f = a[0];
                if (Math.hypot(pt.x - f.x, pt.y - f.y) < 8 * sc) { finishPen(true); return; }
            }
            if (!S.pen.active) { S.pen.active = true; S.pen.anchors = []; S.selected = null; renderLayers(); }
            const an = { x: pt.x, y: pt.y, hIn: null, hOut: null };
            S.pen.anchors.push(an);
            S.pen.dragging = an;
            S.pen.dragStart = { x: pt.x, y: pt.y };
            renderOverlay();
        }
        function penMove(pt) {
            S.hover = pt;
            if (S.pen.dragging) {
                const an = S.pen.dragging;
                an.hOut = { x: pt.x, y: pt.y };
                an.hIn = { x: 2 * an.x - pt.x, y: 2 * an.y - pt.y };
            }
            renderOverlay();
        }
        function penUp() { S.pen.dragging = null; S.pen.dragStart = null; }
        function finishPen(closed) {
            const a = S.pen.anchors;
            if (a.length >= 2) {
                const d = penD(a, closed || S.style.closeByDefault);
                commitPath(d, closed || S.style.closeByDefault ? "closed" : "path");
            }
            S.pen.active = false; S.pen.anchors = []; S.pen.dragging = null; S.hover = null;
            renderOverlay();
        }
        function cancelPen() { S.pen.active = false; S.pen.anchors = []; S.pen.dragging = null; S.hover = null; renderOverlay(); }

        // ---------------- pencil tool ----------------
        function freeDown(pt) { S.free.active = true; S.free.pts = [pt]; S.selected = null; }
        function freeMove(pt) {
            if (!S.free.active) return;
            const last = S.free.pts[S.free.pts.length - 1];
            if (Math.hypot(pt.x - last.x, pt.y - last.y) > pxScale() * 1.5) S.free.pts.push(pt);
            // live preview
            elOverlay.innerHTML = "";
            const el = document.createElementNS(SVGNS, "path");
            el.setAttribute("class", "preview-path");
            el.setAttribute("stroke-width", Math.max(S.style.strokeWidth, 1.2 * pxScale()));
            el.setAttribute("d", smoothD(S.free.pts));
            elOverlay.appendChild(el);
        }
        function freeUp() {
            if (!S.free.active) return;
            S.free.active = false;
            let pts = S.free.pts;
            if (pts.length < 2) { elOverlay.innerHTML = ""; renderOverlay(); return; }
            pts = rdp(pts, pxScale() * 1.6);
            const d = smoothD(pts);
            commitPath(d, "freehand");
            elOverlay.innerHTML = ""; renderOverlay();
        }

        // ---------------- select / move ----------------
        function selectDown(pt, evt) {
            const t = evt.target;
            if (t && t.dataset && t.dataset.id) {
                const id = t.dataset.id;
                selectPath(id);
                const p = S.paths.find(x => x.id === id);
                S.drag = { active: true, id, sx: pt.x, sy: pt.y, base: p.d };
            } else {
                S.selected = null; renderLayers(); renderOverlay();
            }
        }
        function selectMove(pt) {
            if (!S.drag.active) return;
            const p = S.paths.find(x => x.id === S.drag.id);
            if (!p) return;
            const dx = pt.x - S.drag.sx, dy = pt.y - S.drag.sy;
            p.d = translateD(S.drag.base, dx, dy);
            renderArt(); renderOverlay();
        }
        function selectUp() {
            if (S.drag.active) { pushHistory(); renderLayers(); }
            S.drag.active = false; S.drag.id = null;
        }
        // translate all coordinate pairs in a path d-string
        function translateD(d, dx, dy) {
            let i = 0;
            return d.replace(/-?\d*\.?\d+/g, (n) => {
                const v = parseFloat(n) + (i % 2 === 0 ? dx : dy);
                i++; return round(v);
            }).replace(/([MLC Z])/g, (m) => m); // keep letters
        }

        // ---------------- pan / zoom ----------------
        function panDown(evt) { const v = S.view; S.pan = { active: true, sx: evt.clientX, sy: evt.clientY, vx: v.x, vy: v.y }; }
        function panMove(evt) {
            if (!S.pan.active) return;
            const r = stage.getBoundingClientRect();
            const sx = S.view.w / r.width, sy = S.view.h / r.height;
            S.view.x = S.pan.vx - (evt.clientX - S.pan.sx) * sx;
            S.view.y = S.pan.vy - (evt.clientY - S.pan.sy) * sy;
            applyView();
        }
        function panUp() { S.pan.active = false; }
        function zoomAt(cx, cy, factor) {
            const v = S.view;
            const nw = Math.min(Math.max(v.w * factor, S.baseW * 0.05), S.baseW * 40);
            const realFactor = nw / v.w;
            v.x = cx - (cx - v.x) * realFactor;
            v.y = cy - (cy - v.y) * realFactor;
            v.w = nw; v.h = v.h * realFactor;
            applyView();
        }
        function zoomCenter(factor) {
            const c = { x: S.view.x + S.view.w / 2, y: S.view.y + S.view.h / 2 };
            zoomAt(c.x, c.y, factor);
        }
        function fitView() {
            const r = stage.getBoundingClientRect();
            const pad = 1.06;
            const ar = r.width / r.height;
            let w = S.canvasW * pad, h = S.canvasH * pad;
            if (w / h > ar) h = w / ar; else w = h * ar;
            S.view = { x: S.canvasW / 2 - w / 2, y: S.canvasH / 2 - h / 2, w, h };
            S.baseW = S.canvasW * pad;
            applyView();
        }

        // ---------------- pointer routing ----------------
        let spaceDown = false;
        stage.addEventListener("pointerdown", e => {
            stage.setPointerCapture(e.pointerId);
            const pt = toSVG(e);
            if (S.tool === "pan" || spaceDown || e.button === 1) { panDown(e); return; }
            if (e.button !== 0) return;
            if (S.tool === "pen") penDown(pt, e);
            else if (S.tool === "pencil") freeDown(pt);
            else if (S.tool === "select") selectDown(pt, e);
        });
        stage.addEventListener("pointermove", e => {
            const pt = toSVG(e);
            $("stX").textContent = Math.round(pt.x); $("stY").textContent = Math.round(pt.y);
            if (S.pan.active) { panMove(e); return; }
            if (S.tool === "pen") penMove(pt);
            else if (S.tool === "pencil") freeMove(pt);
            else if (S.tool === "select") selectMove(pt);
        });
        stage.addEventListener("pointerup", e => {
            if (S.pan.active) { panUp(); return; }
            if (S.tool === "pen") penUp();
            else if (S.tool === "pencil") freeUp();
            else if (S.tool === "select") selectUp();
        });
        stage.addEventListener("dblclick", e => { if (S.tool === "pen" && S.pen.active) finishPen(false); });
        stage.addEventListener("wheel", e => {
            e.preventDefault();
            const pt = toSVG(e);
            zoomAt(pt.x, pt.y, e.deltaY > 0 ? 1.12 : 0.89);
        }, { passive: false });

        // ---------------- tools ----------------
        function setTool(t) {
            S.tool = t;
            if (t !== "pen" && S.pen.active) finishPen(false);
            document.querySelectorAll(".tool").forEach(el => el.classList.toggle("active", el.dataset.tool === t));
            $("stTool").textContent = t;
            stage.style.cursor = t === "pan" ? "grab" : t === "select" ? "default" : "crosshair";
            const msgs = {
                pen: "Click to place anchor points · drag to pull curve handles · Enter to finish",
                pencil: "Draw freehand — release to finish the path",
                select: "Click a path to select · drag to move it",
                pan: "Drag to pan · scroll to zoom"
            };
            $("stMsg").textContent = msgs[t];
            renderArt();
        }
        document.querySelectorAll(".tool").forEach(el => {
            el.addEventListener("click", () => setTool(el.dataset.tool));
        });

        // ---------------- image loading ----------------
        function loadImageFile(file) {
            if (!file || !file.type.startsWith("image/")) { toast("That file isn't an image", "err"); return; }
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    S.img = { href: reader.result, w: img.naturalWidth, h: img.naturalHeight };
                    S.canvasW = img.naturalWidth; S.canvasH = img.naturalHeight;
                    S.paths = []; S.selected = null; S.history = []; S.redo = [];
                    buildStage();
                    renderArt(); renderLayers();
                    fitView();
                    $("empty").classList.add("hide");
                    toast("Image loaded — start tracing");
                };
                img.onerror = () => toast("Couldn't read that image", "err");
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        }
        $("fileInput").addEventListener("change", e => { if (e.target.files[0]) loadImageFile(e.target.files[0]); e.target.value = ""; });
        $("uploadBtn").addEventListener("click", () => $("fileInput").click());
        $("dropUpload").addEventListener("click", () => $("fileInput").click());

        // drag & drop
        const dz = $("dropzone"), wrap = $("canvasWrap");
        ["dragenter", "dragover"].forEach(ev => wrap.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("drag"); }));
        ["dragleave", "drop"].forEach(ev => wrap.addEventListener(ev, e => { e.preventDefault(); if (ev !== "dragleave" || e.target === wrap) dz.classList.remove("drag"); }));
        wrap.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("drag"); if (e.dataTransfer.files[0]) loadImageFile(e.dataTransfer.files[0]); });

        // ---------------- auto-trace (optional, loads from CDN) ----------------
        // cdnjs no longer hosts this package (its URL 404s) — jsdelivr/unpkg mirror
        // the same npm release, tried in order so one blocked/dead host doesn't
        // sink auto-trace entirely.
        const TRACER_URLS = [
            "https://cdn.jsdelivr.net/npm/imagetracerjs@1.2.6/imagetracer_v1.2.6.js",
            "https://unpkg.com/imagetracerjs@1.2.6/imagetracer_v1.2.6.js",
        ];
        let tracerLoaded = false;
        function loadScript(src) {
            return new Promise((res, rej) => {
                const s = document.createElement("script");
                s.src = src;
                s.onload = res;
                s.onerror = () => rej(new Error("failed to load " + src));
                document.head.appendChild(s);
            });
        }
        async function ensureTracer() {
            if (tracerLoaded && window.ImageTracer) return;
            let lastErr;
            for (const url of TRACER_URLS) {
                try { await loadScript(url); if (window.ImageTracer) { tracerLoaded = true; return; } }
                catch (e) { lastErr = e; }
            }
            throw lastErr || new Error("ImageTracer failed to load");
        }
        $("autoBtn").addEventListener("click", async () => {
            if (!S.img) { toast("Upload an image first", "err"); return; }
            toast("Loading auto-tracer…");
            try {
                await ensureTracer();
                window.ImageTracer.imageToSVG(S.img.href, (svgstr) => {
                    try {
                        const doc = new DOMParser().parseFromString(svgstr, "image/svg+xml");
                        const nodes = doc.querySelectorAll("path");
                        if (!nodes.length) { toast("Auto-trace produced no paths", "err"); return; }
                        pushHistory();
                        nodes.forEach(n => {
                            const fill = n.getAttribute("fill") || "#000";
                            S.paths.push({
                                id: uid(), d: n.getAttribute("d"), type: "auto",
                                stroke: "none", strokeWidth: 0, fill, closed: true
                            });
                        });
                        renderArt(); renderLayers();
                        toast(nodes.length + " paths traced automatically");
                    } catch (err) { toast("Couldn't parse the trace", "err"); }
                }, { ltres: 1, qtres: 1, pathomit: 8, numberofcolors: 16 });
            } catch (e) {
                toast("Auto-trace needs internet & couldn't load — trace manually instead", "err");
            }
        });

        // ---------------- export ----------------
        function buildSVG() {
            const W = S.canvasW, H = S.canvasH;
            const toppersByPath = computeToppers(S.paths);
            let defsBody = "", body = "";
            S.paths.forEach((p, i) => {
                const hasFill = p.fill && p.fill !== "none";
                const toppers = toppersByPath[i];
                let maskId = null;

                if (hasFill && toppers.length) {
                    maskId = "mask-" + p.id;
                    defsBody += `\n    <mask id="${maskId}" maskUnits="userSpaceOnUse">` +
                        `<path d="${p.d}" fill="white"/>` +
                        toppers.map(t => `<path d="${t.d}" fill="black"/>`).join("") +
                        `</mask>`;
                }
                if (hasFill) {
                    body += `\n  <path d="${p.d}" fill="${p.fill}"${maskId ? ` mask="url(#${maskId})"` : ""}/>`;
                }
                if (p.stroke && p.stroke !== "none") {
                    const attrs = [
                        `d="${p.d}"`, `fill="none"`, `stroke="${p.stroke}"`,
                        p.strokeWidth ? `stroke-width="${p.strokeWidth}"` : "",
                        `stroke-linecap="round"`, `stroke-linejoin="round"`
                    ].filter(Boolean).join(" ");
                    body += `\n  <path ${attrs}/>`;
                }
            });
            const defs = defsBody ? `\n  <defs>${defsBody}\n  </defs>` : "";
            return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}${body}\n</svg>`;
        }
        $("exportBtn").addEventListener("click", () => {
            if (!S.paths.length) { toast("Nothing to export yet", "err"); return; }
            const blob = new Blob([buildSVG()], { type: "image/svg+xml" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = "trace.svg"; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 500);
            toast("Exported trace.svg");
        });
        $("copyBtn").addEventListener("click", async () => {
            if (!S.paths.length) { toast("Nothing to copy yet", "err"); return; }
            try { await navigator.clipboard.writeText(buildSVG()); toast("SVG code copied to clipboard"); }
            catch { toast("Couldn't access clipboard", "err"); }
        });

        // ---------------- style controls ----------------
        function syncStyleUI() {
            $("strokeColor").value = S.style.stroke;
            $("strokeHex").value = S.style.stroke.toUpperCase();
            $("strokeWidth").value = S.style.strokeWidth;
            $("strokeWidthVal").textContent = S.style.strokeWidth;
            $("fillColor").value = S.style.fill;
            $("fillHex").value = S.style.fill.toUpperCase();
            $("fillToggle").classList.toggle("on", S.style.fillOn);
            $("fillSwatch").style.opacity = S.style.fillOn ? 1 : .4;
            $("fillSwatch").style.pointerEvents = S.style.fillOn ? "auto" : "none";
            $("fillHex").style.opacity = S.style.fillOn ? 1 : .4;
            $("fillHex").style.pointerEvents = S.style.fillOn ? "auto" : "none";
            $("closeToggle").classList.toggle("on", S.style.closeByDefault);
        }
        $("strokeColor").addEventListener("input", e => { S.style.stroke = e.target.value; $("strokeHex").value = e.target.value.toUpperCase(); applyStyleToSelected(); });
        $("strokeHex").addEventListener("input", e => { let v = e.target.value; if (/^#[0-9a-fA-F]{6}$/.test(v)) { S.style.stroke = v; $("strokeColor").value = v; applyStyleToSelected(); } });
        $("strokeWidth").addEventListener("input", e => { S.style.strokeWidth = parseFloat(e.target.value); $("strokeWidthVal").textContent = e.target.value; applyStyleToSelected(); });
        $("fillColor").addEventListener("input", e => { S.style.fill = e.target.value; $("fillHex").value = e.target.value.toUpperCase(); applyStyleToSelected(); });
        $("fillHex").addEventListener("input", e => { let v = e.target.value; if (/^#[0-9a-fA-F]{6}$/.test(v)) { S.style.fill = v; $("fillColor").value = v; applyStyleToSelected(); } });
        $("fillToggle").addEventListener("click", () => { S.style.fillOn = !S.style.fillOn; syncStyleUI(); applyStyleToSelected(); });
        $("closeToggle").addEventListener("click", () => { S.style.closeByDefault = !S.style.closeByDefault; syncStyleUI(); });

        // image controls
        $("imgOpacity").addEventListener("input", e => { S.imgOpacity = e.target.value / 100; $("imgOpacityVal").textContent = e.target.value + "%"; applyImg(); });
        $("imgToggle").addEventListener("click", () => { S.imgVisible = !S.imgVisible; $("imgToggle").classList.toggle("on", S.imgVisible); applyImg(); });

        // clear / help
        $("clearBtn").addEventListener("click", () => {
            if (!S.paths.length) return;
            pushHistory(); S.paths = []; S.selected = null; cancelPen();
            renderArt(); renderLayers(); renderOverlay(); toast("Cleared all paths");
        });
        $("undoBtn").addEventListener("click", undo);
        $("helpBtn").addEventListener("click", () => toast("V select · P pen · B pencil · H pan · Ctrl+Z undo · Enter finish · Esc cancel · Del remove · 0 fit"));

        // zoom controls
        $("zoomIn").addEventListener("click", () => zoomCenter(0.83));
        $("zoomOut").addEventListener("click", () => zoomCenter(1.2));
        $("zoomFit").addEventListener("click", fitView);

        // ---------------- keyboard ----------------
        window.addEventListener("keydown", e => {
            if (e.target.matches("input")) return;
            if (e.code === "Space") { spaceDown = true; stage.style.cursor = "grab"; e.preventDefault(); return; }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
            switch (e.key.toLowerCase()) {
                case "v": setTool("select"); break;
                case "p": setTool("pen"); break;
                case "b": setTool("pencil"); break;
                case "h": setTool("pan"); break;
                case "enter": if (S.pen.active) finishPen(false); break;
                case "escape": if (S.pen.active) cancelPen(); else { S.selected = null; renderLayers(); renderOverlay(); } break;
                case "backspace":
                    if (S.pen.active && S.pen.anchors.length) { e.preventDefault(); S.pen.anchors.pop(); if (!S.pen.anchors.length) S.pen.active = false; renderOverlay(); }
                    break;
                case "delete": if (S.selected) deletePath(S.selected); break;
                case "0": fitView(); break;
                case "=": case "+": zoomCenter(0.83); break;
                case "-": zoomCenter(1.2); break;
            }
        });
        window.addEventListener("keyup", e => { if (e.code === "Space") { spaceDown = false; stage.style.cursor = S.tool === "pan" ? "grab" : S.tool === "select" ? "default" : "crosshair"; } });
        window.addEventListener("resize", () => applyView());

        // ---------------- toast ----------------
        let toastTimer;
        function toast(msg, kind) {
            const t = $("toast"); $("toastMsg").textContent = msg;
            t.classList.toggle("err", kind === "err"); t.classList.add("show");
            clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
        }

        // ---------------- install as app (PWA) ----------------
        // hidden unless the browser tells us it's actually installable (Chrome/Edge
        // etc. — Safari/iOS never fires this, so the button just stays hidden there)
        let deferredInstallPrompt = null;
        const installBtn = $("installBtn");
        const alreadyInstalled = () =>
            window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
        if (alreadyInstalled()) installBtn.hidden = true;
        window.addEventListener("beforeinstallprompt", e => {
            e.preventDefault();
            deferredInstallPrompt = e;
            if (!alreadyInstalled()) installBtn.hidden = false;
        });
        installBtn.addEventListener("click", async () => {
            if (!deferredInstallPrompt) return;
            installBtn.hidden = true;
            deferredInstallPrompt.prompt();
            const choice = await deferredInstallPrompt.userChoice;
            deferredInstallPrompt = null;
            if (choice.outcome !== "accepted") installBtn.hidden = false;
        });
        window.addEventListener("appinstalled", () => { installBtn.hidden = true; toast("Traceboard installed"); });

        // ---------------- init ----------------
        buildStage(); fitView(); syncStyleUI(); setTool("pen");
    