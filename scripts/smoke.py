# Headless UI smoke test (iPad viewport, touch + pen). Usage: python3 scripts/smoke.py [url] [outdir]
import sys, json
from playwright.sync_api import sync_playwright
url = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000/'
out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/shots'
errs = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True, device_scale_factor=1)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    pg.on('console', lambda m: errs.append('CONSOLE ' + m.text) if m.type == 'error' else None)
    pg.goto(url); pg.wait_for_timeout(600)
    pg.screenshot(path=f'{out}/1-start.png')
    pg.click('.sample[data-sample*="cat"]'); pg.click('#startBtn')
    pg.wait_for_selector('#studio:not([hidden])', timeout=20000); pg.wait_for_timeout(1500)
    pg.screenshot(path=f'{out}/2-studio.png')
    # draw strokes with a pen-type pointer via dispatched events
    res = pg.evaluate('''async () => {
      const vp = document.getElementById('viewport'); const r = vp.getBoundingClientRect();
      const ids = []; const brushes = [...document.querySelectorAll('.brush-chip')].map(c => c.dataset.id);
      const fire = (t, x, y, pt='pen', pid=7, pr=0.5) => vp.dispatchEvent(new PointerEvent(t, {pointerId:pid, pointerType:pt, isPrimary:true, clientX:x, clientY:y, pressure:pr, bubbles:true, cancelable:true, buttons: t==='pointerup'?0:1}));
      let n=0;
      for (const id of brushes) {
        document.querySelector(`.brush-chip[data-id="${id}"]`).click();
        const y0 = r.top + 60 + n*38; n++;
        fire('pointerdown', r.left+200, y0);
        for (let i=1;i<=24;i++){ fire('pointermove', r.left+200+i*14, y0+Math.sin(i/3)*14, 'pen', 7, 0.3+0.5*Math.sin(i/8)**2); await new Promise(r=>setTimeout(r,8)); }
        fire('pointerup', r.left+540, y0);
      }
      return {brushes, strokes: window.__cb.engine.strokeTotal};
    }''')
    print('draw:', res)
    pg.wait_for_timeout(500); pg.screenshot(path=f'{out}/3-drawn.png')
    pg.click('#btnCheck2'); pg.wait_for_timeout(1500); pg.screenshot(path=f'{out}/4-check.png')
    pg.click('#btnCompare'); pg.wait_for_timeout(300); pg.screenshot(path=f'{out}/5-ghost.png')
    pg.click('#btnCompare'); pg.click('#btnCompare')
    pg.click('#scDone'); pg.wait_for_timeout(900); pg.screenshot(path=f'{out}/6-step2.png')
    pg.click('#rtabs button[data-pane="panePalette"]'); pg.click('#btnPeel'); pg.wait_for_timeout(500); pg.screenshot(path=f'{out}/7-peel.png')
    pg.click('#modalClose')
    pg.click('#btnUndo'); pg.click('#btnRedo')
    pg.click('#btnFinish'); pg.wait_for_timeout(900); pg.screenshot(path=f'{out}/8-recap.png')
    print('ERRORS:', json.dumps(errs, indent=1) if errs else 'none')
    b.close()
