// Put photo.png beside this file in the chosen scripts directory.
api.requireVersion(1);
api.create({
  id: 'custom-image', name: 'Local image / compositing',
  async preload(ctx) {
    const url = await ctx.assetURL('photo.png');
    ctx.state.image = await new Promise((resolve, reject) => ctx.p.loadImage(url, resolve, reject));
  },
  draw({ p, state }) {
    p.background(12); p.tint(255, 180);
    p.image(state.image, 0, 0, p.width, p.height); p.noTint();
    p.blendMode(p.ADD); p.fill(40, 50, 80); p.circle(p.width / 2, p.height / 2, 100); p.blendMode(p.BLEND);
  },
});
