// The splash window (splash.html): the version as VB6 showed it, major.minor ("0.10" for 0.10.0).
export const splashVersion = (version: string): string => version.split('.').slice(0, 2).join('.');

const el = typeof document === 'undefined' ? null : document.getElementById('version');
if (el) el.textContent = splashVersion(__APP_VERSION__);
