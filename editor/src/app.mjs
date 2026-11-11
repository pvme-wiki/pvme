import './theme.mjs';
import { editorMode } from './hosted-workflow.mjs';
// The standalone prototype stays a visibly labelled browser-only demo.
// /edit/ always uses the hosted service, including when it is unavailable.
document.documentElement.dataset.editorMode = editorMode(location);
if (editorMode(location) === 'hosted') await import('./hosted.mjs');
else await import('./demo.mjs');
