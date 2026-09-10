#!/usr/bin/env python3
"""Build review artifacts from replacement-visuals.spec.js (requires Pillow).
Usage: python3 scripts/replacement-contact-sheets.py [evidence-directory]
No browser work is repeated. Files stay under ignored test-results/ by default.
"""
import html
import json
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'test-results/replacement-evidence')
ids = 'truchet-relay counterweight membrane-modes ratchet-wheel pin-relief folded-spire schlieren-flow tidal-glass vector-knot prism-scanner video-slit-scan video-facet-fold bitplane-rewire riso-misprint barn-doors stair-wipe iris-diaphragm cellular-gate'.split()
font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
font = ImageFont.truetype(font_path, 17) if Path(font_path).exists() else ImageFont.load_default()
small = ImageFont.truetype(font_path, 11) if Path(font_path).exists() else ImageFont.load_default()
metrics = [json.loads((root / id / 'metrics.json').read_text()) for id in ids]
(root / 'metrics.json').write_text(json.dumps(metrics, indent=2) + '\n')
links = []
for page in range(3):
    subset = ids[page * 6:(page + 1) * 6]
    sheet = Image.new('RGB', (1280, 6 * 212 + 30), '#121a26')
    draw = ImageDraw.Draw(sheet)
    for x, text in enumerate(['A: synchronized silence', 'B: modest audio (0.2)', 'Strong audio (0.85)', '|A - B| x 3']):
        draw.text((x * 320 + 8, 5), text, fill='white', font=font)
    for row, id in enumerate(subset):
        y = 30 + row * 212
        draw.text((8, y + 3), id.replace('-', ' ').title(), fill='#bfe4ec', font=font)
        for col, kind in enumerate(['silence', 'modest', 'strong', 'diff']):
            sheet.paste(Image.open(root / id / f'{kind}.png').convert('RGB'), (col * 320, y + 28))
    filename = f'contact-{page + 1}.png'; sheet.save(root / filename)
    frames = []
    for frame in range(24):
        image = Image.new('RGB', (480, 6 * 111 + 25), '#121a26'); draw = ImageDraw.Draw(image)
        draw.text((5, 5), f'SILENCE             PULSED AUDIO        DIFF x3    {frame / 20:.2f}s', fill='white', font=small)
        for row, id in enumerate(subset):
            y = 25 + row * 111; draw.text((4, y), id, fill='white', font=small)
            for col, kind in enumerate(['silence', 'pulse', 'diff']):
                thumb = Image.open(root / id / f'{kind}-{frame:02d}.png').convert('RGB').resize((160, 90))
                image.paste(thumb, (col * 160, y + 17))
        frames.append(image)
    gif = f'comparison-{page + 1}.gif'
    frames[0].save(root / gif, save_all=True, append_images=frames[1:], duration=50, loop=0)
    links.append(f'<h2>Patterns {page * 6 + 1}–{page * 6 + 6}</h2><p><a href="{gif}">Animated silence / pulsed audio / diff (1.2 s)</a></p><a href="{filename}"><img src="{filename}" width="1280" alt="Six labeled A/B/strong/difference comparisons"></a>')
rows = ''.join(f'<tr><td>{html.escape(m["id"])}</td><td>{m["modest"]["rgb"]:.2f}</td><td>{100*m["modest"]["coverage"]:.1f}%</td><td>{100*m["modest"]["edge"]:.1f}%</td><td>{min(v["rgb"] for v in m["bands"].values()):.2f}</td></tr>' for m in metrics)
(root / 'index.html').write_text('''<!doctype html><meta charset="utf-8"><title>Replacement pattern evidence</title><style>body{background:#101622;color:#e5edf8;font:16px system-ui;margin:24px}a{color:#7adddf}img{max-width:100%;height:auto}td,th{padding:6px 15px;border-bottom:1px solid #345;text-align:left}</style><h1>18 replacement patterns — synchronized render evidence</h1><p>320×180; 24 frames at 20 Hz; default motion speed; fresh instance/controller/camera history for every condition. Duplicate silence and zero sliders must be pixel-identical. Five synchronized timeline samples determine the reported mean; autonomous motion is measured separately. Animated GIFs are silent and show synthetic feature pulses, not recorded microphone audio.</p><p><a href="metrics.json">Full numerical metrics</a> · <a href="integration.json">Web Audio and alpha integration</a></p><table><tr><th>Pattern</th><th>RGB MAD /255</th><th>Changed area (&gt;16)</th><th>Normalized edge XOR area</th><th>Weakest band RGB MAD</th></tr>''' + rows + '</table>' + ''.join(links))
print(root / 'index.html')
