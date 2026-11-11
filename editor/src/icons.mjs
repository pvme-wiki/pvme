const paths = {
  book:'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4V4Zm16 0h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h3V4Z',
  arrow:'M5 12h14m-6-6 6 6-6 6', back:'M19 12H5m6-6-6 6 6 6',
  check:'m5 12 4 4L19 6', plus:'M12 5v14M5 12h14',
  review:'M8 3h8v4H8V3Zm-2 2H4v16h16V5h-2M8 12h8m-8 4h5',
  eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  pen:'m4 16-1 5 5-1L20 8l-4-4L4 16Zm9-9 4 4',
  lock:'M6 10h12v11H6V10Zm3 0V6a3 3 0 0 1 6 0v4m-3 5v2',
  device:'M7 2h10v20H7V2Zm4 17h2',
  search:'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  close:'m6 6 12 12M6 18 18 6', chevron:'m9 5 7 7-7 7',
  info:'M12 10v7m0-11v1m9 5a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  history:'M3 10a9 9 0 1 1 1 7M3 4v6h6m3-3v6l4 2',
  globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  warning:'m12 3 10 18H2L12 3Zm0 6v5m0 3v1',
  help:'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 4m0 3v1m9-6a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  branch:'M6 8v8m12-8a6 6 0 0 1-6 6H6m3-9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm0 14a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM21 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z'
};
export const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.book}"/></svg>`;
export const rune = `<svg class="rune" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="m24 3 19 11v21L24 46 5 35V14L24 3Z" stroke="currentColor"/><path d="m24 10 12 7v14l-12 7-12-7V17l12-7Zm0 0v28M12 17l12 7 12-7M12 31l12-7 12 7" stroke="currentColor" stroke-width="1.2"/></svg>`;
const artPaths = {
  frost:'M100 35 115 63l-3 42 18 26-30 39-30-39 18-26-3-42Zm0 0v135M85 63l15 20 15-20m-27 42 12 15 12-15m-42 26 30 9 30-9M52 69l10 22-4 30 13 17-19 25-20-25 13-17-4-30Zm96 0 11 22-4 30 13 17-20 25-19-25 13-17-4-30ZM100 12v12m-6-6h12M33 47v12m-6-6h12m134 2v12m-6-6h12',
  interface:'M35 48h130v100H35V48Zm0 24h130M80 72v76m-45-50h45m19-8h48m-48 14h32m-32 14h48M46 60h3m10 0h3m10 0h3M87 163h26m-13-15v15M139 127l30 11-14 5-5 16-11-32Z',
  magic:'M100 30 149 63v72l-49 35-49-35V63L100 30Zm0 16 35 26v55l-35 26-35-26V72l35-26Zm0 18-20 34 20 13 20-13-20-34Zm0 47v29M51 63l14 9m70 0 14-9M51 135l14-8m70 0 14 8M29 94v14m-7-7h14m135-30v14m-7-7h14M85 18h30',
  necro:'M100 37c-32 0-45 23-42 48l10 27v24h64v-24l10-27c3-25-10-48-42-48Zm-17 94v18m17-18v24m17-24v18M76 81l17 9-15 11-2-20Zm48 0-17 9 15 11 2-20Zm-24 22-7 15h14l-7-15ZM42 127c-15-13 3-27-3-40m119 40c15-13-3-27 3-40M64 27l-7-12m79 12 7-12',
  rasial:'M45 166V86c0-69 110-69 110 0v80M58 166V87c0-51 84-51 84 0v79M76 160l-12-39 13-30 5-30 18-15 18 15 5 30 13 30-12 39M82 61l18 24 18-24m-41 30 23 7 23-7m-47 69 24-45 24 45M88 91l4 1m16 0 4-1M100 115v-17'
};
export function art(type='frost') { return `<svg class="guide-art" viewBox="0 0 200 200" fill="none" aria-hidden="true"><circle cx="100" cy="100" r="87" stroke="currentColor" opacity=".17"/><circle cx="100" cy="100" r="71" stroke="currentColor" opacity=".1" stroke-dasharray="2 6"/><path d="${artPaths[type] || artPaths.frost}" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 100h9m156 0h9M100 13v9m0 156v9" stroke="currentColor" opacity=".5"/></svg>`; }
