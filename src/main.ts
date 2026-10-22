import { getBackend } from './backend/backend';

const app = document.getElementById('app');
if (app) app.textContent = 'VibeBasic';

void getBackend().showMainWindow();
