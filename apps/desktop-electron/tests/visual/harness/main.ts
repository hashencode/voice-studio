import { app, BrowserWindow, screen } from "electron";

const width = Number(process.env.VOICE2TEXT_VISUAL_WIDTH ?? "1240");
const height = Number(process.env.VOICE2TEXT_VISUAL_HEIGHT ?? "820");
const rendererUrl = process.env.VOICE2TEXT_VISUAL_RENDERER_URL;
const preloadPath = process.env.VOICE2TEXT_VISUAL_PRELOAD;

if (!rendererUrl || !preloadPath) {
  throw new Error(
    "VOICE2TEXT_VISUAL_RENDERER_URL and VOICE2TEXT_VISUAL_PRELOAD are required",
  );
}
const requiredRendererUrl = rendererUrl;
const requiredPreloadPath = preloadPath;

app.commandLine.appendSwitch("lang", "zh-CN");
app.commandLine.appendSwitch("hide-scrollbars");

void start();

async function start() {
  await app.whenReady();
  const displayScaleFactor = screen.getPrimaryDisplay().scaleFactor;
  const physicalWidth = Math.round(width / displayScaleFactor);
  const physicalHeight = Math.round(height / displayScaleFactor);

  const window = new BrowserWindow({
    width: physicalWidth,
    height: physicalHeight,
    useContentSize: true,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: requiredPreloadPath,
    },
  });

  await window.loadURL(requiredRendererUrl);
  window.setContentSize(physicalWidth, physicalHeight);
  window.show();

  window.on("closed", () => app.quit());
}
