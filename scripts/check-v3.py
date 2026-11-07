# Headless checks for: unlabeled markers, sketch-first flow, sketch→paint, Shield stress test, poisoned images.
# Usage: python3 scripts/check-v3.py [url] [skull.jpg] [outdir]
import sys, json, os
from playwright.sync_api import sync_playwright
url = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000/'
skull = sys.argv[2] if len(sys.argv) > 2 else '/mnt/user-data/uploads/7ca96745-image.jpg'
out = sys.argv[3] if len(sys.argv) > 3 else '/tmp/shots3'
os.makedirs(out, exist_ok=True)
errs, res = [], {}
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=True)
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
    pg.on('console', lambda m: errs.append('CONSOLE ' + m.text) if m.type == 'error' else None)
    pg.goto(url); pg.wait_for_timeout(500)
    # ---------- 1. skull, Sketch -> Paint
    pg.set_input_files('#fileInput', skull); pg.wait_for_timeout(400)
    pg.click('#modeSeg button[data-mode="sketch_paint"]'); pg.select_option('#mediumSel', 'Digital painting')
    pg.click('#startBtn'); pg.wait_for_selector('#studio:not([hidden])', timeout=30000); pg.wait_for_timeout(1200)
    res['steps'] = pg.evaluate("[...document.querySelectorAll('#stepList li b')].map(b=>b.textContent)")
    res['text_in_guides'] = pg.evaluate("document.querySelectorAll('#guides text').length")
    res['shapes_in_guides'] = pg.evaluate("document.querySelectorAll('#guides polygon, #guides ellipse').length")
    pg.screenshot(path=f'{out}/skull-step1.png')
    pg.click('#btnNext'); pg.wait_for_timeout(600); pg.screenshot(path=f'{out}/skull-step2.png')
    res['targets_card'] = pg.evaluate("[...document.querySelectorAll('#scTargets li')].map(l=>l.textContent)")
    pg.click('#btnNext'); pg.wait_for_timeout(600); pg.screenshot(path=f'{out}/skull-step3.png')
    # ---------- 3. Shield stress test + poisoned sample
    pg.click('#btnShield'); pg.wait_for_timeout(500)
    pg.click('text=Run stress test'); pg.wait_for_timeout(1200)
    res['stress'] = pg.evaluate("(document.querySelector('#modalBody p b')||{}).textContent")
    pg.click('text=Hidden in EXIF + comment (JPEG)'); pg.wait_for_timeout(1500)
    res['poison'] = pg.evaluate("[...document.querySelectorAll('#modalBody .shield-log')].map(u=>u.textContent).join(' | ').slice(-400)")
    pg.screenshot(path=f'{out}/shield.png')
    res['errors'] = errs
    print(json.dumps(res, indent=1)); b.close()
