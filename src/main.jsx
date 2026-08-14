import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import './styles/index.css';
import { createWindowIdentity } from './platform/identity.js';
import { createVizStore } from './state/createVizStore.js';
import { createAppRuntime } from './app/runtime.js';
import { RuntimeContext } from './app/RuntimeContext.jsx';
import { App } from './app/App.jsx';
import { SingletonError } from './components/errors/SingletonError.jsx';

const identity = createWindowIdentity();
const store = createVizStore(identity.role);

function Root() {
  const [runtime, setRuntime] = useState(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    let disposed = false;
    const rt = createAppRuntime({ ...identity, store });
    rt.claim().then((allowed) => {
      if (disposed) { rt.dispose(); return; }
      if (allowed) setRuntime(rt);
      else setBlocked(true);
    });
    return () => {
      disposed = true;
      rt.dispose();
    };
  }, []);

  if (blocked) return <SingletonError role={identity.role} />;
  if (!runtime) return null;

  return (
    <RuntimeContext.Provider value={{ store, runtime }}>
      <App role={identity.role} />
    </RuntimeContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(
  <>
    <Root />
    <Analytics />
  </>
);

// HMR: dispose the runtime + re-mount without leaking leases/channels.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    try { store.setState({ bootStatus: 'blocked' }); } catch { /* noop */ }
  });
}
