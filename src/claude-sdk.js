// Bundled by build.js (esbuild, IIFE) so the single-file site can call the Claude API
// directly from the browser with the user's own API key.
import Anthropic from '@anthropic-ai/sdk';
window.Anthropic = Anthropic;
