'use strict';

/**
 * Visual review run (XODE2_TEST=look): Claude is blocked, the steps in the
 * script named by XODE2_LOOK run against the window, and screenshots are
 * saved to XODE2_OUT. The script exports `async ({ run, shot, wait, win }) => {}`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

async function runLookTest(win) {
  win.webContents.setBackgroundThrottling(false);
  const outDir = process.env.XODE2_OUT;
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = (js) => win.webContents.executeJavaScript(js);
  const shot = async (name) => {
    // A covered window may not repaint on its own; ask for a fresh frame first.
    win.webContents.invalidate();
    await wait(150);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  };
  win.webContents.on('console-message', (event) => {
    const { level, message } = event;
    if (level === 'warning' || level === 'error' || level >= 2) console.log(`LOOK_CONSOLE ${message}`);
  });
  await wait(1200);
  try {
    const steps = require(path.resolve(process.env.XODE2_LOOK));
    await steps({ run, shot, wait, win });
    console.log('LOOK_DONE');
  } catch (error) {
    console.log(`LOOK_FAIL ${error.stack || error.message}`);
  }
  app.quit();
}

module.exports = { runLookTest };
