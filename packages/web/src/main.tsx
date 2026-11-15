import { createRoot } from 'react-dom/client';
import { App } from './App';
import { registerServiceWorker, watchInstall } from './pwa';
import { OfficeStore } from './store';
import './styles.css';

watchInstall();
registerServiceWorker();

const store = new OfficeStore();
store.start();

const root = document.getElementById('root');
if (!root) throw new Error('elemento #root ausente');
createRoot(root).render(<App store={store} />);
