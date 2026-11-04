/**
 * The scene's painter, off the page's thread (scene.js initScene starts it
 * with the canvas): the page sends what to paint ({ type: 'update', state }),
 * and the picture files a scene asks for, which the page reads and this opens.
 */

import { createPainter, decodePicture } from './scene.js';

let painter = null;
const waiting = new Map(); // picture -> [{ resolve, reject }]

function loadImage(src) {
  return new Promise((resolve, reject) => {
    if (!waiting.has(src)) {
      waiting.set(src, []);
      self.postMessage({ type: 'image', src });
    }
    waiting.get(src).push({ resolve, reject });
  });
}

self.onmessage = ({ data }) => {
  if (data.type === 'init') painter = createPainter(data.canvas, { loadImage, onStop: () => self.postMessage({ type: 'stopped' }) });
  else if (data.type === 'update') painter?.update(data.state);
  else if (data.type === 'stats') self.postMessage({ type: 'stats', stats: painter?.stats() || null });
  else if (data.type === 'image') {
    const all = waiting.get(data.src) || [];
    waiting.delete(data.src);
    // (Opened here, off the page.)
    const image = data.file ? decodePicture(data.file, data.most) : Promise.reject(new Error(`couldn't load ${data.src}`));
    for (const { resolve } of all) resolve(image);
  }
};
