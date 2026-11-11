/* Run before styles: one preference for the reader and editor, no light flash.
   A classic script deliberately avoids module/defer scheduling. New visits use
   Night; saved System follows the OS. Storage failure only disables persistence. */
(() => {
  const key = 'pvme-theme';
  const root = document.documentElement;
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['light', 'dark', 'system'].includes(value) ? value : 'dark';
  const read = (fallback = 'dark') => { try { return valid(localStorage.getItem(key)); } catch { return fallback; } };
  let preference = read();
  let controls = [];
  const apply = () => {
    root.dataset.theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    root.dataset.themePreference = preference;
    controls.forEach(control => { control.value = preference; });
  };
  apply();
  const connect = () => {
    controls = [...document.querySelectorAll('[data-theme-control]')];
    controls.forEach(control => {
      control.value = preference;
      control.closest('.theme-control').hidden = false;
      control.addEventListener('change', () => {
        preference = valid(control.value);
        try { localStorage.setItem(key, preference); } catch { /* Keep the current session usable. */ }
        apply();
      });
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connect, { once: true });
  else connect();
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = read(preference);
    apply();
  });
  window.addEventListener('pageshow', () => { preference = read(preference); apply(); });
})();
