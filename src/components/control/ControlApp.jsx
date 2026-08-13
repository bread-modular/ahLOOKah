import { useEffect } from 'react';
import { useRuntime } from '../../app/RuntimeContext.jsx';
import { ControlPanel } from './ControlPanel.jsx';

export function ControlApp() {
  const { runtime } = useRuntime();

  useEffect(() => {
    runtime.bootControl();
  }, [runtime]);

  return <ControlPanel />;
}
