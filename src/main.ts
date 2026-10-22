import { getBackend } from './backend/backend';
import { startIde } from './ide/main';

const backend = getBackend();
startIde(backend);
void backend.showMainWindow();
