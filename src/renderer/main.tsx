import { createRoot } from 'react-dom/client';
import './styles/app.css';
import { App } from './App';
import { boot } from './state/controller';
import { api } from './api';

window.addEventListener('error', (e) => api.system.log('error', `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => api.system.log('error', `unhandled rejection: ${String((e.reason as Error)?.stack ?? e.reason)}`));

createRoot(document.getElementById('root')!).render(<App />);
void boot();
