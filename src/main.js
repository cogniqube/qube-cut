const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const ffprobePath = require('ffprobe-static').path.replace('app.asar', 'app.asar.unpacked');
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

let mainWindow;
let logFilePath;

function log(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFilePath, line);
  } catch (_) {}
}

function createWindow() {
  logFilePath = path.join(app.getPath('userData'), 'qube-cut.log');
  log(`App start. ffmpegPath=${ffmpegPath} exists=${fs.existsSync(ffmpegPath)}`);
  log(`ffprobePath=${ffprobePath} exists=${fs.existsSync(ffprobePath)}`);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#1e1e24',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });
}

app.whenReady().then(createWindow);

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err && err.stack ? err.stack : err}`);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('open-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('probe-file', async (event, filePath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err.message);
      const stream = data.streams.find((s) => s.codec_type === 'video');
      resolve({
        duration: data.format.duration,
        width: stream ? stream.width : null,
        height: stream ? stream.height : null,
      });
    });
  });
});

ipcMain.handle('choose-save-path', async (event, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'export.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (result.canceled) return null;
  return result.filePath;
});

// clips: [{ path, start, end }]  in seconds; resolution: '1280x720' etc; fps: number
ipcMain.handle('export-video', async (event, { clips, outputPath, resolution, fps }) => {
  const tmpDir = path.join(app.getPath('temp'), 'qube-cut-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  const segmentFiles = [];

  const sendProgress = (pct, label) => {
    mainWindow.webContents.send('export-progress', { pct, label });
  };

  log(`Export requested: ${clips.length} clip(s) -> ${outputPath}, res=${resolution}, fps=${fps}`);

  try {
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const segPath = path.join(tmpDir, `seg${i}.mp4`);
      const [resW, resH] = resolution.split('x');
      await new Promise((resolve, reject) => {
        ffmpeg(clip.path)
          .setStartTime(clip.start)
          .duration(Math.max(0.05, clip.end - clip.start))
          .videoFilters(`scale=${resW}:${resH}:force_original_aspect_ratio=decrease,pad=${resW}:${resH}:(ow-iw)/2:(oh-ih)/2`)
          .fps(fps)
          .outputOptions([
            '-c:v libx264',
            '-preset medium',
            '-crf 16',
            '-profile:v high',
            '-level 5.1',
            '-c:a aac',
            '-b:a 256k',
            '-pix_fmt yuv420p',
          ])
          .on('start', (cmd) => log(`ffmpeg start (clip ${i + 1}/${clips.length}): ${cmd}`))
          .on('stderr', (line) => log(`ffmpeg stderr: ${line}`))
          .on('progress', (p) => {
            const overall = ((i + (p.percent || 0) / 100) / clips.length) * 90;
            sendProgress(overall, `Processing clip ${i + 1} of ${clips.length}`);
          })
          .on('end', () => {
            log(`ffmpeg end (clip ${i + 1}/${clips.length})`);
            resolve();
          })
          .on('error', (err) => {
            log(`ffmpeg error (clip ${i + 1}/${clips.length}): ${err && err.message ? err.message : err}`);
            reject(err);
          })
          .save(segPath);
      });
      segmentFiles.push(segPath);
    }

    if (segmentFiles.length === 1) {
      fs.copyFileSync(segmentFiles[0], outputPath);
      log(`Copied single segment to ${outputPath}`);
    } else {
      const listFile = path.join(tmpDir, 'list.txt');
      fs.writeFileSync(
        listFile,
        segmentFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
      );
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listFile)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c copy'])
          .on('start', (cmd) => log(`ffmpeg concat start: ${cmd}`))
          .on('stderr', (line) => log(`ffmpeg concat stderr: ${line}`))
          .on('progress', () => sendProgress(95, 'Combining clips'))
          .on('end', () => {
            log('ffmpeg concat end');
            resolve();
          })
          .on('error', (err) => {
            log(`ffmpeg concat error: ${err && err.message ? err.message : err}`);
            reject(err);
          })
          .save(outputPath);
      });
    }

    log(`Export finished successfully: ${outputPath}, exists=${fs.existsSync(outputPath)}`);
    sendProgress(100, 'Done');
    return { success: true, outputPath };
  } catch (err) {
    log(`Export failed: ${err && err.stack ? err.stack : err}`);
    return { success: false, error: String(err) };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
});
