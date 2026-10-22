import { getBackend } from './backend/backend';
import { boot } from './boot';
import { startIde } from './ide/main';
import { showErrorBox, startRuntime } from './runtime/runtimeMain';

const backend = getBackend();
void boot(backend, {
  startIde,
  startRuntime,
  showError: t => showErrorBox(t).catch(() => {}),
});
