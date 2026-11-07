# Headless check: the bucket fill must meet the drawn line with no transparent halo. Usage: python3 scripts/check-fill.py [url]
import sys, json
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg = b.new_context(viewport={'width':1180,'height':820}, has_touch=True).new_page()
    logs=[]; pg.on('console', lambda m: logs.append(m.text)); pg.on('pageerror', lambda e: logs.append('ERR '+str(e)))
    pg.goto(sys.argv[1] if len(sys.argv)>1 else 'http://localhost:3000/'); pg.wait_for_timeout(400)
    pg.click('.sample[data-sample*="cat"]'); pg.click('#modeSeg button[data-mode="free"]'); pg.click('#startBtn')
    pg.wait_for_selector('#studio:not([hidden])', timeout=30000); pg.wait_for_timeout(800)
    r = pg.evaluate('''async () => {
      const eng = window.__cb.engine, vp = document.getElementById('viewport'), r = vp.getBoundingClientRect();
      document.querySelector('.brush-chip[data-id="pencil"]').click();
      const fire = (t, x, y, pt='pen') => vp.dispatchEvent(new PointerEvent(t, {pointerId:5, pointerType:pt, isPrimary:true, clientX:x, clientY:y, pressure:0.6, bubbles:true, cancelable:true, buttons:t==='pointerup'?0:1}));
      const cx = r.left + r.width*0.45, cy = r.top + r.height*0.5, R = 90;
      fire('pointerdown', cx+R, cy);
      for (let i=1;i<=60;i++){ const a=i/60*Math.PI*2; fire('pointermove', cx+Math.cos(a)*R, cy+Math.sin(a)*R); await new Promise(q=>setTimeout(q,5)); }
      fire('pointerup', cx+R, cy);
      const s1 = eng.strokeTotal;
      document.getElementById('btnFill').click(); await new Promise(q=>setTimeout(q,100));
      const tool = eng.tool;
      const d = eng.docPoint(cx, cy);
      fire('pointerdown', cx, cy, 'pen'); fire('pointerup', cx, cy, 'pen'); await new Promise(q=>setTimeout(q,500)); const ok = eng.strokeTotal;
      const layer = eng.layers[eng.active], g = layer.canvas.getContext('2d');
      const dr = eng.docPoint(cx+R, cy), Rdoc = Math.hypot(dr.x-d.x, dr.y-d.y);
      // scan along +x ray: print alpha at fractions
      const prof = []; for (let px=-30; px<=14; px++) prof.push([px, g.getImageData(Math.round(d.x+Rdoc+px), Math.round(d.y), 1,1).data[3]]);
      return {s1, tool, ok, active: eng.active, layers: eng.layers.length, Rdoc: Math.round(Rdoc), prof};
    }''')
    prof = r['prof']; gaps = [px for px, a in prof if px <= -3 and a < 250]
    print('fill → pixels from 30px inside the line to 14px outside:', ''.join('#' if a >= 250 else ('+' if a > 0 else '.') for _, a in prof))
    print('PASS: the fill meets the line with no gap' if not gaps else f'FAIL: transparent gap at {gaps}')
    b.close(); sys.exit(1 if gaps else 0)
