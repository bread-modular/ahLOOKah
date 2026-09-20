// Put clip.mp4 beside this file. Browser-supported video codec required.
api.requireVersion(1);
api.create({
  id: 'custom-video', name: 'Local video / playback cleanup',
  async setup(ctx) {
    const { p, state, signal, runtime, onCleanup } = ctx;
    const url = await ctx.assetURL('clip.mp4');
    if (signal.aborted) return;
    const video = state.video = p.createVideo(url);
    video.hide(); video.elt.muted = true; video.elt.loop = true;
    onCleanup(() => video.remove());
    runtime.addPlaybackLifecycle?.({ pause: () => video.pause(), resume: () => video.play() });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('clip.mp4: video readiness timed out')), 8000);
      const done = () => { clearTimeout(timer); resolve(); };
      video.elt.addEventListener('loadeddata', done, { once: true, signal });
      video.elt.addEventListener('error', () => { clearTimeout(timer); reject(new Error('clip.mp4: unsupported or broken video')); }, { once: true, signal });
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      if (video.elt.readyState >= 2) done();
    });
    if (!signal.aborted && !runtime.isPaused?.()) await video.elt.play();
  },
  draw({ p, state }) {
    p.background(0);
    if (state.video?.elt.readyState >= 2) p.image(state.video, 0, 0, p.width, p.height);
  },
});
