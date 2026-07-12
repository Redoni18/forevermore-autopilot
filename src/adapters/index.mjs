/**
 * @file Default renderer-adapter bundle (AP-203), keyed by the route names the
 * render stage uses (`routeAdapter` → 'poster' | 'video' | 'capture'). Tests
 * inject a stub bundle of the same shape instead of driving real Brave/Remotion.
 */

import { renderPoster } from './poster.mjs';
import { renderVideo } from './video.mjs';
import { capture } from './capture.mjs';

/** @type {import('../types.mjs').RendererAdapters & {poster:Function, video:Function}} */
export const defaultAdapters = {
  poster: renderPoster,
  video: renderVideo,
  capture,
  // convenience aliases matching the typedef property names
  renderPoster,
  renderVideo,
};

export { renderPoster, renderVideo, capture };
