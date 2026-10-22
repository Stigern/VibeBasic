import { getBackend } from './backend/backend';
import { boot } from './boot';
import { startIde } from './ide/main';
import { requestQuit, showErrorBox, startRuntime } from './runtime/runtimeMain';

const backend = getBackend();
void boot(backend, {
  startIde,
  startRuntime,
  onQuit: requestQuit,
  showError: t => showErrorBox(t).catch(() => {}),
});
