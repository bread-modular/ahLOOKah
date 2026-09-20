api.requireVersion(1);
const id = api.create({
  id: 'custom-crud', name: 'Temporary name',
  setup({ state, onCleanup }) {
    state.tick = 0;
    const timer = setInterval(() => state.tick++, 1000);
    onCleanup(() => clearInterval(timer));
    const listener = () => { state.tick = 0; };
    window.addEventListener('online', listener);
    onCleanup(() => window.removeEventListener('online', listener));
  },
  draw({ p, state }) {
    p.background(15); p.fill(255); p.textSize(22);
    p.text(`Alive ${state.tick}s`, 20, 40);
  },
  dispose({ state }) { state.tick = 0; },
});
api.update(id, { name: 'CRUD / resource lifecycle' });
api.create({ ...api.get(id), id: 'custom-temporary', name: 'Never activated' });
api.delete('custom-temporary'); // Registry only. Never deletes a disk file.
// api.list() returns this file's staged definitions. CRUD is synchronous during
// registration, not callable from draw/timers. Rewrite this file to change it.
