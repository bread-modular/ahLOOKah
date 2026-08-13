import { useRuntime } from './RuntimeContext.jsx';
import { ScreenApp } from '../components/screen/ScreenApp.jsx';
import { ControlApp } from '../components/control/ControlApp.jsx';

export function App({ role }) {
  const { runtime } = useRuntime();
  if (role === 'screen') return <ScreenApp />;
  return <ControlApp />;
}
