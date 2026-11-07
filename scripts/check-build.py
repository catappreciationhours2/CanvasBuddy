import sys, json, os
from playwright.sync_api import sync_playwright
url=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:3000/'; out=sys.argv[2] if len(sys.argv)>2 else '/tmp/shots-build'; os.makedirs(out,exist_ok=True)
# usage: python3 scripts/check-build.py [url] [outdir] [skull.jpg] — shapes-first + precise outline on the built-in figure sample and a photo
skull=sys.argv[3] if len(sys.argv)>3 else '/tmp/skull.jpg'
errs=[]; res={}
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':1180,'height':820}, has_touch=True); pg=ctx.new_page()
    pg.on('pageerror', lambda e: errs.append('PAGEERROR '+str(e)))
    pg.on('console', lambda m: errs.append('CONSOLE '+m.text) if m.type=='error' else None)
    for name,path in [('figure',None),('skull',skull)]:
        pg.goto(url); pg.wait_for_timeout(400)
        if path: pg.set_input_files('#fileInput', path)
        else: pg.click('button[data-sample="samples/sample-figure.svg"]')
        pg.wait_for_timeout(500)
        res[name+'_toggles']=pg.evaluate("[document.getElementById('optConstruct').checked, document.getElementById('optPrecise').checked]")
        pg.click('#startBtn'); pg.wait_for_selector('#studio:not([hidden])', timeout=30000); pg.wait_for_timeout(1200)
        res[name+'_steps']=pg.evaluate("[...document.querySelectorAll('#stepList li b')].map(b=>b.textContent)")
        res[name+'_text']=pg.evaluate("document.querySelectorAll('#guides text').length")
        res[name+'_card1']=pg.evaluate("[...document.querySelectorAll('#scTargets li')].map(l=>l.textContent)")
        pg.screenshot(path=f'{out}/{name}-1-solids.png')
        pg.click('#btnNext'); pg.wait_for_timeout(700); pg.screenshot(path=f'{out}/{name}-2-outline.png')
        res[name+'_outline_pts']=pg.evaluate("(document.querySelector('#guides polygon')||{getAttribute:()=>''}).getAttribute('points').split(' ').length")
    res['errors']=errs; print(json.dumps(res,indent=1)); b.close()
