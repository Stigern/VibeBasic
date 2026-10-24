import { registerAiOptionsTab } from './ai/optionsTab';
import { getBackend } from './backend/backend';
import { boot } from './boot';
import { blockBrowserKeys } from './browserKeys';
import { startIde } from './ide/main';
import { requestQuit, showErrorBox, startRuntime } from './runtime/runtimeMain';

blockBrowserKeys(window);
const backend = getBackend();
registerAiOptionsTab(backend);
void boot(backend, {
  startIde,
  startRuntime,
  onQuit: requestQuit,
  showError: t => showErrorBox(t).catch(() => {}),
});
