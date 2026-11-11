// Runs before styles load to avoid a bright flash when opening a night-mode guide.
(() => {
  let preference = 'dark';
  try { preference = localStorage.getItem('pvme-theme') || 'dark'; } catch {}
  if (!['light', 'dark', 'system'].includes(preference)) preference = 'dark';
  const dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePreference = preference;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#151e1b' : '#f5f3eb');
})();
