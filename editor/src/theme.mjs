import { validTheme, resolveTheme } from './hosted-workflow.mjs';
let preference = 'dark';
try { preference = validTheme(localStorage.getItem('pvme-theme')); } catch {}
const media = window.matchMedia('(prefers-color-scheme: dark)');
export function applyTheme(value = preference, persist = false) {
  preference = validTheme(value);
  document.documentElement.dataset.theme = resolveTheme(preference, media.matches);
  document.documentElement.dataset.themePreference = preference;
  if (persist) { try { localStorage.setItem('pvme-theme', preference); } catch {} }
  document.querySelectorAll('[data-theme-select]').forEach(select => { select.value = preference; });
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', document.documentElement.dataset.theme === 'dark' ? '#151e1b' : '#f5f3eb');
}
export const themeOptions = () => `<label class="theme-picker"><span class="sr-only">Color theme</span><select data-theme-select aria-label="Color theme">${[['system','System'],['light','Day'],['dark','Night']].map(([value,label])=>`<option value="${value}" ${preference===value?'selected':''}>${label}</option>`).join('')}</select></label>`;
media.addEventListener('change', () => applyTheme());
window.addEventListener('storage', event => { if (event.key === 'pvme-theme') applyTheme(event.newValue); });
document.addEventListener('change', event => { if (event.target.matches('[data-theme-select]')) applyTheme(event.target.value, true); });
applyTheme();
