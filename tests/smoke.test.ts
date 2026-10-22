import { getBackend } from '../src/backend/backend';
test('browser backend is chosen outside Tauri', () => {
  expect(getBackend().kind).toBe('browser');
});
