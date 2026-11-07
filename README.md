# 🎨 CanvasBuddy + Palette

An AI-assisted art learning studio that **teaches the artist instead of generating art**. Upload a reference, get a step-by-step lesson with optional guides (construction shapes, value maps, palette, edges), draw in the built-in canvas (10 brushes, iPad + Apple Pencil ready), and get short, evidence-based feedback from Buddy.

Zero dependencies. Node ≥ 18. No build step.

## Run it
```bash
cp .env.example .env        # then paste the hackathon OpenRouter key into .env
npm run check-key           # optional: verifies key + lists cheap vision models
npm start                   # prints http://localhost:3000 and a LAN URL for the iPad
```
No key? It still works in **offline demo mode** (local lesson, local critique). The key stays server-side and `.env` is git-ignored.

## iPad
Same Wi-Fi → open the LAN URL printed by `npm start` in Safari → Share → *Add to Home Screen* for full screen.
Apple Pencil draws (pressure + tilt, palm rejection); fingers pan/zoom. Two-finger tap = undo, three-finger tap = redo. The ☝️ button toggles whether fingers draw.

## What makes the lessons specific
- **Stick figure → shapes → line art.** The outline step is the picture's *line art* — what is left if you pull out all the colour: outer shape *and* inner lines (whiskers, folds, features), extracted in `public/js/lineart.js` (paper-normalise → thin-mark / edge detection → hysteresis → Zhang–Suen thinning → stroke tracing → Douglas–Peucker). Order: stick figure & line of action → simple shapes → "Follow the main lines" → "Add the finer lines" (sketch modes). Pencil sketches use a mark detector that ignores shading; photos and paintings use Sobel edges. In **Sketch** and **Sketch → Paint** only, you can also *Build from simple shapes first* — a stick figure with a line of action, then spheres, boxes, cylinders and a line of action fitted to the subject; offline this needs a clean silhouette such as the **Full-body pose** sample — on smoky photos the lesson says it needs the AI tutor). The AI plans the solids but never the outline: the app inserts the measured line art itself.
- **A sketch comes first.** Every lesson (except abstract / pixel-art, and free mode) includes the measured line-art trace. If the AI skips it, `ensureSketch` injects one from the image's pixels.
- **Markers are shapes only** – no numbers or labels on the board. The step card names each marker with an icon; the instruction says where it is in words. Look code: purple outline = sketch line, tinted hollow = dark opening, hatch = shade, dots = lift, fat dotted edge = soften.
- The AI receives the reference *plus* a gridded copy with measured regions (D# dark, L# light, H# hollows) so it can "snap" to exact pixel outlines. The **Audit Agent** checks every marker against the pixels, repairs near-misses, regenerates once if too many fail, otherwise badges steps *Unverified*.
- **Modes:** Tonal, Sketch, **Sketch → Paint** (outline first, then paint it), Paint, Style, Pixel, Free.
- Fill closes right up to the outline (no white seam).

## Perfect Artist (harness check)
`/test.html` simulates a beginner who follows every marker literally, then compares the result to the reference: sketch-first, solids sit on / cover the subject and come before the outline, line-art-on-real-lines and strong-line coverage, step coverage, instruction/geometry consistency, shadows land where dark, lights left alone, tone pattern, detail recall, sketch lines on real edges. A deliberately broken lesson button proves the checker can fail.

## Comparing models
Set `ALLOWED_MODELS` (comma list) in `.env`; `/test.html` has a model dropdown. Run the same image (the skull) on each and compare audit + Perfect Artist scores. Check current OpenRouter pricing before choosing.

## Security features (Shield button 🛡️)
1. **Prompt-injection sandbox** – goal text is sanitised (hidden/bidi characters, fake `</system>` tags, "ignore previous…", links, encoded blobs), wrapped as untrusted data, and optionally second-opinioned by a tiny guardrail model call (`GUARD_LLM=0` disables).
2. **Pixel & metadata hygiene** – images are re-drawn in the browser (EXIF/GPS dropped), optionally grayscale and/or **blurred in areas you choose**, then byte-checked and metadata-stripped again on the server; hidden instructions found inside metadata are reported. "👁 Preview what is sent" shows the exact payload.
3. **Output guardrail** – every model string is scanned for leaked keys, a per-process canary token, injection echoes, links and HTML before it reaches the UI (which only uses `textContent`).
4. **Audit Agent + adversarial suite** – `/test.html` → "Adversarial suite" simulates a hallucinating/manipulated tutor and shows the auditor catching it.
5. **Stress test it:** Shield → *Run stress test* (53 checks incl. false-positive controls, from `/api/selftest`); `npm run redteam` in a terminal; *Poisoned samples* (EXIF/PNG-text injections in `public/samples`); `/test.html` → Security stress test; and the manual "Try an attack" box. Known gaps are reported, not hidden: paraphrased injections slip past the pattern filter, and text painted into pixels can't be removed.
6. Hardening: strict CSP and security headers, rate limiting, size caps, key never leaves the server, security event log at `/api/security` (categories only, no content).

## Test plan (≈10 min)
1. `npm test` — 50 tests (analysis, lessons, audit, guardrails incl. hostile model output, journey, server vs. mock OpenRouter).
2. `npm start`; try the cat sample, then **upload your own photo** (e.g. the skull). With a key: the status badge says "AI on"; check each step shows unlabeled markers and a 🛡️ verified badge.
3. Draw with every brush; try 🪣 fill inside a closed outline (gap-closing slider in Layers), hide the Scaffold layer, undo/redo (2-finger / 3-finger tap on iPad).
4. **Check my progress** reports per-marker progress ("Darkest shape: 62% filled — lower left needs tone").
5. Finish → recap (Buddy does a happy spin on save); Journey gallery; delete works per item.
6. Open `/test.html`, drop **any** image, run *offline* or *AI* lesson → per-step overlays, audit table, Perfect Artist replay. "Download debug bundle" saves lesson + audit + stats as JSON (send it to whoever is debugging).
7. 🛡️ Shield → "Try an attack". Start screen → 🔒 Privacy → blur an area / preview what is sent.
8. `python3 scripts/smoke.py`, `check-v3.py`, `check-fill.py`, `check-build.py` for headless UI checks (check-build screenshots the solids + precise outline).

## Honest limitations
- Perfect Artist silhouette scores are only meaningful when a lesson blocks in the whole subject; the audit checks marker placement against pixels, not teaching quality (needs humans).
- Live OpenRouter output and real-iPad/Pencil behaviour could only be tested with a mock model and synthetic events here.
- Peel layers are a plausible teaching sequence, not the artist's real process.
