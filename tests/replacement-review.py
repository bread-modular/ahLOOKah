"""Build the focused review gallery from actual saved rendered audits, no rerender.
Run: python3 tests/replacement-review.py
Requires Pillow only for this optional review artifact step (not npm tests).
"""
import base64
import io
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path('test-results/replacement-strength')
OUT = Path('docs/replacement-strength-assets')
OUT.mkdir(parents=True, exist_ok=True)
IDS = ['counterweight', 'ratchet-wheel', 'vector-knot', 'prism-scanner', 'riso-misprint', 'barn-doors',
       'iris-diaphragm', 'truchet-relay', 'membrane-modes', 'schlieren-flow', 'tidal-glass', 'bitplane-rewire',
       'stair-wipe', 'cellular-gate', 'pin-relief', 'folded-spire', 'video-slit-scan', 'video-facet-fold']
BANDS = ['neutral', 'bass', 'mid', 'high']
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 16)
small = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 12)

def picture(uri):
    return Image.open(io.BytesIO(base64.b64decode(uri.split(',', 1)[1]))).convert('RGB')

def strip(frames, title, before=False):
    out = Image.new('RGB', (1280, 228), '#0c111c')
    draw = ImageDraw.Draw(out)
    draw.text((12, 5), title + (' | BEFORE 9f707fe' if before else ' | AFTER') + ' | real -60 dBFS pulses, default gain', font=font, fill='#e0eaf9')
    for i, band in enumerate(BANDS):
        draw.text((i * 320 + 12, 29), band.upper(), font=small, fill='#9dcef2')
        out.paste(picture(frames[band]), (i * 320, 48))
    return out

results = {id: json.loads((ROOT / f'{id}.json').read_text()) for id in IDS}
rows = []
for id, result in results.items():
    name = id.replace('-', ' ').title()
    for key, suffix, before in [('animation', '', False), ('beforeAnimation', '-before', True)]:
        # 24 frames at 30 Hz, preserve timing rather than slow down for effect.
        frames = [strip(frame, name, before).resize((960, 171), Image.Resampling.LANCZOS) for frame in result[key]]
        durations = [33, 33, 34] * 8
        frames[0].save(OUT / f'{id}{suffix}.webp', save_all=True, append_images=frames[1:], duration=durations, loop=0, quality=72, method=4)
    strip(result['stills'], name).save(OUT / f'{id}.png')
    rows.append(f'<section id="{id}"><h2>{name}</h2><picture><source media="(prefers-reduced-motion: reduce)" srcset="replacement-strength-assets/{id}.png"><img loading="lazy" src="replacement-strength-assets/{id}.webp" alt="{name}: silence, bass, mid, high animated comparison"></picture><details><summary>Before, same actual analyzer recording</summary><img loading="lazy" src="replacement-strength-assets/{id}-before.webp" alt="Before {name}"></details></section>')

for batch in range(3):
    sheet = Image.new('RGB', (1024, 1200), '#0c111c')
    draw = ImageDraw.Draw(sheet)
    draw.text((12, 10), 'REAL ANALYZER -60 dBFS | AFTER | SILENCE / BASS / MID / HIGH', font=font, fill='white')
    for row, id in enumerate(IDS[batch * 6:batch * 6 + 6]):
        frame = strip(results[id]['stills'], id.replace('-', ' ').title()).resize((1024, 182), Image.Resampling.LANCZOS)
        sheet.paste(frame, (0, 42 + row * 190))
    sheet.save(OUT / f'contact-{batch + 1}.png')

metrics = {id: {k: v for k, v in r.items() if k not in ['animation', 'beforeAnimation', 'stills']} for id, r in results.items()}
(OUT / 'metrics.json').write_text(json.dumps(metrics, indent=2))
html = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Replacement structural audio review</title>
<style>body{background:#090f18;color:#e1edf9;font:16px system-ui;max-width:1280px;margin:32px auto;padding:0 20px}img{width:100%;height:auto}section{margin:48px 0}a{color:#99d7ff}summary{cursor:pointer;padding:12px}p{max-width:85ch;line-height:1.6}</style>
<h1>Replacement structural audio review</h1><p>Only the existing replacement designs. Each row compares equal-time silence / bass-only / mid-only / high-only at default gain and nonzero Motion Speed. Short 0.8-second loops show two real weak input pulses; the cut back to frame zero is a review loop, not a renderer discontinuity. Camera input is a deterministic moving chart. No physical microphone, projector, or user recording was available.</p>
<p>AudioContext oscillators → production AudioManager / AnalyserNode → canonical normalization and replacement-only support → real controller engine, schema validation and default delayed store → p5 Canvas/WebGL. BEFORE uses the actual files from 9f707fe, not an imitation. The other sliders are zeroed to isolate each mapping.</p>
<p><a href="replacement-strength.md">Signal findings, mappings, validation and limitations</a> · <a href="replacement-strength-assets/metrics.json">Full geometry / temporal metrics</a></p>
'''
Path('docs/replacement-strength-review.html').write_text(html + '\n'.join(rows) + '</html>')
print(f'Created {len(IDS)} before/after animations, stills, 3 contact sheets and metrics in {OUT}')
