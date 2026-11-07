#!/usr/bin/env python3
"""Generates the three bundled sample references (all original artwork, no licensing concerns)."""
import os
out = os.path.join(os.path.dirname(__file__), '..', 'public', 'samples')
os.makedirs(out, exist_ok=True)

# 1) Line-art cat. Shapes mirror test/helpers.js CAT_SHAPES so the Perfect Artist harness has ground truth.
ink = '#2b2a33'
cat = f'''<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
<rect width="800" height="800" fill="#ffffff"/>
<g fill="#ffffff" stroke="{ink}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
  <ellipse cx="400" cy="576" rx="216" ry="152"/>
  <polygon points="272,208 264,80 360,160"/>
  <polygon points="528,208 536,80 440,160"/>
  <ellipse cx="400" cy="288" rx="152" ry="136"/>
  <polygon points="284,190 281,118 336,166" stroke-width="4"/>
  <polygon points="516,190 519,118 464,166" stroke-width="4"/>
  <ellipse cx="348" cy="272" rx="17" ry="24" fill="{ink}"/>
  <ellipse cx="452" cy="272" rx="17" ry="24" fill="{ink}"/>
  <polygon points="386,314 414,314 400,330" fill="{ink}" stroke-width="3"/>
  <path d="M400 330 C400 352 380 358 366 350 M400 330 C400 352 420 358 434 350" fill="none"/>
  <path d="M356 640 L356 718 M444 640 L444 718" fill="none"/>
  <ellipse cx="356" cy="722" rx="26" ry="12"/><ellipse cx="444" cy="722" rx="26" ry="12"/>
</g>
<g stroke="{ink}" stroke-width="4" stroke-linecap="round" fill="none">
  <path d="M310 318 L232 304 M310 334 L228 344 M310 350 L240 382"/>
  <path d="M490 318 L568 304 M490 334 L572 344 M490 350 L560 382"/>
  <path d="M380 196 L384 224 M400 190 L400 222 M420 196 L416 224"/>
  <path d="M300 540 C330 590 330 600 300 640 M500 540 C470 590 470 600 500 640" />
</g>
</svg>'''
open(os.path.join(out, 'sample-cat.svg'), 'w').write(cat)

# 2) Painterly sunset landscape
land = '''<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a9a3e0"/><stop offset="0.45" stop-color="#f1b9c9"/><stop offset="0.8" stop-color="#fbd9a8"/></linearGradient>
  <linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3c6b5"/><stop offset="1" stop-color="#7f8fc9"/></linearGradient>
  <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#fff6d6"/><stop offset="0.6" stop-color="#ffe3a1"/><stop offset="1" stop-color="#ffe3a1" stop-opacity="0"/></radialGradient>
</defs>
<rect width="960" height="640" fill="url(#sky)"/>
<circle cx="640" cy="330" r="150" fill="url(#sun)"/>
<circle cx="640" cy="330" r="54" fill="#fff3cc"/>
<g fill="#ffffff" opacity="0.55"><ellipse cx="200" cy="130" rx="120" ry="22"/><ellipse cx="260" cy="150" rx="90" ry="16"/><ellipse cx="760" cy="90" rx="100" ry="18"/></g>
<polygon points="0,380 120,300 210,350 330,250 470,360 560,320 700,380 820,290 960,370 960,640 0,640" fill="#8f98d4"/>
<polygon points="0,430 160,360 300,420 450,350 610,430 780,370 960,430 960,640 0,640" fill="#a7c4a3"/>
<rect x="0" y="440" width="960" height="200" fill="url(#lake)"/>
<g fill="#fff3cc" opacity="0.6"><rect x="580" y="452" width="120" height="8" rx="4"/><rect x="598" y="472" width="84" height="7" rx="3"/><rect x="612" y="490" width="56" height="6" rx="3"/></g>
<polygon points="0,520 140,470 300,540 460,500 640,560 820,500 960,540 960,640 0,640" fill="#5f7a74"/>
<g fill="#3f5551"><polygon points="90,520 118,430 146,520"/><polygon points="130,525 154,450 178,525"/><polygon points="800,520 830,420 860,520"/><polygon points="850,525 876,455 902,525"/></g>
<polygon points="0,590 200,548 420,600 700,560 960,598 960,640 0,640" fill="#34473f"/>
</svg>'''
open(os.path.join(out, 'sample-landscape.svg'), 'w').write(land)

# 3) 16x16 pixel mushroom sprite
rows = [
"................",
".....rrrrrr.....",
"...rrrwwrrrrr...",
"..rrwwwwrrrwwr..",
".rrrwwwwrrrwwrr.",
".rrrrwwrrrrrrrr.",
"rrwwrrrrrrwwwrrr",
"rrwwwrrrrrwwwrrr",
"rrrwwrrrrrrwwrrr",
"rrrrrrrrrrrrrrrr",
".kkkkkkkkkkkkkk.",
".....ssssss.....",
".....ssssss.....",
".....sskkss.....",
".....ssssss.....",
"....kkkkkkkk....",
]
col = {'r':'#e8708a','w':'#fff6e6','k':'#5a4a6a','s':'#f6dcc0','.':None}
rects = ''.join(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{col[c]}"/>' for y,row in enumerate(rows) for x,c in enumerate(row) if col[c])
px = f'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges"><rect width="16" height="16" fill="#c7ddc5"/>{rects}</svg>'
open(os.path.join(out, 'sample-pixel.svg'), 'w').write(px)
print('samples written')
