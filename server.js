const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const execFileAsync = promisify(execFile);

process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.RENDER_SERVER_TOKEN || "";
const BASE_DIR = "/tmp/video-render";
const OUTPUT_DIR = path.join(BASE_DIR, "output");
const MAX_ASSET_BYTES = Number(process.env.MAX_ASSET_BYTES || 400 * 1024 * 1024);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const jobs = new Map();

function createId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

const FORMATS = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "16:9": { width: 1920, height: 1080 },
};

function getResolution(resolution, format) {
  if (resolution && typeof resolution === "object") {
    const w = Number(resolution.width);
    const h = Number(resolution.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
  }
  if (typeof resolution === "string" && resolution.includes("x")) {
    const [w, h] = resolution.split("x").map(Number);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
  }
  return FORMATS[format] || FORMATS["9:16"];
}

function auth(req, res) {
  if (!TOKEN) return true;
  const authorization = req.headers.authorization || "";
  if (authorization !== `Bearer ${TOKEN}`) {
    res.status(401).json({ status: "error", error: "Unauthorized" });
    return false;
  }
  return true;
}

// ffmpeg/ffprobe com prioridade baixa para não travar o event loop (CPU do plano Free é fraca).
async function run(bin, args) {
  try {
    return await execFileAsync("nice", ["-n", "10", bin, ...args], { maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    const tail = String(err.stderr || err.message || "").slice(-800);
    throw new Error(`${bin} falhou: ${tail}`);
  }
}

// Download em streaming direto para o disco (sem carregar o arquivo na memória).
async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Não foi possível baixar o arquivo (${response.status}): ${url}`);
  }
  const len = Number(response.headers.get("content-length") || 0);
  if (len && len > MAX_ASSET_BYTES) throw new Error(`Arquivo muito grande (${len} bytes)`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
  return destination;
}

async function hasAudioStream(file) {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_type", "-of", "default=noprint_wrappers=1:nokey=1", file,
    ]);
    return stdout.trim() === "audio";
  } catch {
    return false;
  }
}

function isImageScene(scene) {
  const t = (scene.asset_type || "").toLowerCase();
  if (t === "image" || t === "logo") return true;
  try {
    const ext = path.extname(new URL(scene.asset_url).pathname).slice(1).toLowerCase();
    return ["jpg", "jpeg", "png", "webp", "gif"].includes(ext);
  } catch {
    return false;
  }
}

function escapeTextFile(text) {
  return String(text || "").replace(/\r/g, "").trim();
}

const SILENT = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];
const ENCODE = [
  "-c:v", "libx264", "-preset", "veryfast", "-threads", "1", "-crf", "23", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart",
];

async function createScene(scene, index, workDir, width, height, downloads) {
  const duration = Math.max(0.5, Number(scene.duration) || 3);
  const outputFile = path.join(workDir, `scene-${index}.mp4`);

  // Cada URL é baixada uma única vez por render (cenas repetem o mesmo material).
  let inputFile = downloads.get(scene.asset_url);
  if (!inputFile) {
    inputFile = path.join(workDir, `input-${downloads.size}`);
    await downloadFile(scene.asset_url, inputFile);
    downloads.set(scene.asset_url, inputFile);
  }

  const filters = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
    "fps=30",
  ];

  const onScreenText = escapeTextFile(scene.on_screen_text);
  const caption = escapeTextFile(scene.caption);

  if (onScreenText) {
    const textFile = path.join(workDir, `text-${index}.txt`);
    fs.writeFileSync(textFile, onScreenText, "utf8");
    filters.push(
      `drawtext=textfile='${textFile}':fontcolor=white:fontsize=64:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:box=1:boxcolor=black@0.55:boxborderw=20:x=(w-text_w)/2:y=h*0.15`
    );
  }
  if (caption) {
    const captionFile = path.join(workDir, `caption-${index}.txt`);
    fs.writeFileSync(captionFile, caption, "utf8");
    filters.push(
      `drawtext=textfile='${captionFile}':fontcolor=white:fontsize=42:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:box=1:boxcolor=black@0.65:boxborderw=15:x=(w-text_w)/2:y=h*0.82`
    );
  }
  const filter = filters.join(",");

  if (isImageScene(scene)) {
    await run("ffmpeg", [
      "-y", "-threads", "1", "-loop", "1", "-i", inputFile, ...SILENT,
      "-t", String(duration), "-vf", filter, "-filter_threads", "1",
      "-map", "0:v:0", "-map", "1:a:0", ...ENCODE, outputFile,
    ]);
  } else if (await hasAudioStream(inputFile)) {
    // mantém o áudio original (fala/depoimento); apad garante áudio até o fim da cena
    await run("ffmpeg", [
      "-y", "-threads", "1", "-i", inputFile,
      "-t", String(duration), "-vf", filter, "-af", "apad", "-filter_threads", "1",
      "-map", "0:v:0", "-map", "0:a:0", ...ENCODE, outputFile,
    ]);
  } else {
    await run("ffmpeg", [
      "-y", "-threads", "1", "-i", inputFile, ...SILENT,
      "-t", String(duration), "-vf", filter, "-filter_threads", "1",
      "-map", "0:v:0", "-map", "1:a:0", ...ENCODE, outputFile,
    ]);
  }

  return { file: outputFile, duration };
}

async function concatScenes(sceneFiles, outputFile) {
  const listFile = path.join(path.dirname(outputFile), "concat.txt");
  const content = sceneFiles.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(listFile, content, "utf8");
  await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", outputFile]);
}

async function processRender(renderId, requestBody, publicBaseUrl) {
  const workDir = path.join(BASE_DIR, renderId);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    jobs.set(renderId, { render_id: renderId, status: "processing", progress: 1 });
    const scenes = requestBody.scenes || [];
    const { width, height } = getResolution(requestBody.resolution, requestBody.format);
    const downloads = new Map();
    const sceneFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = await createScene(scenes[i], i, workDir, width, height, downloads);
      sceneFiles.push(scene.file);
      jobs.set(renderId, { render_id: renderId, status: "processing", progress: Math.round(((i + 1) / scenes.length) * 90) });
    }

    // libera os originais (podem ter centenas de MB) antes de concatenar
    for (const f of downloads.values()) fs.rmSync(f, { force: true });

    const outputFile = path.join(OUTPUT_DIR, `${renderId}.mp4`);
    await concatScenes(sceneFiles, outputFile);

    jobs.set(renderId, {
      render_id: renderId,
      status: "completed",
      progress: 100,
      render_url: `${publicBaseUrl}/output/${renderId}.mp4`,
    });
  } catch (error) {
    console.error("Erro no render:", renderId, error.message);
    jobs.set(renderId, { render_id: renderId, status: "error", progress: 0, error: error.message });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Um render por vez: o plano Free (512 MB) não aguenta ffmpeg em paralelo.
let queue = Promise.resolve();
function enqueue(task) {
  queue = queue.then(task).catch((e) => console.error("queue:", e));
}

app.get("/", (req, res) => res.json({ status: "online", service: "video-render-server", ffmpeg: true }));
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/output", express.static(OUTPUT_DIR));

app.post("/render", (req, res) => {
  if (!auth(req, res)) return;
  try {
    const { scenes } = req.body || {};
    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ status: "error", error: "scenes é obrigatório e deve conter pelo menos uma cena" });
    }
    const invalid = scenes
      .map((s, i) => ({ n: (s && s.order) || i + 1, ok: !!(s && typeof s.asset_url === "string" && /^https?:\/\//i.test(s.asset_url)) }))
      .filter((x) => !x.ok)
      .map((x) => x.n);
    if (invalid.length) {
      return res.status(400).json({ status: "error", error: `Cenas sem asset_url válido (ordem: ${invalid.join(", ")})` });
    }

    const renderId = createId();
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const publicBaseUrl = `${protocol}://${req.get("host")}`;

    jobs.set(renderId, { render_id: renderId, status: "processing", progress: 0 });
    enqueue(() => processRender(renderId, req.body, publicBaseUrl));

    return res.json({ render_id: renderId, status: "processing", progress: 0 });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ status: "error", error: error.message });
  }
});

app.get("/render/:id", (req, res) => {
  if (!auth(req, res)) return;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ status: "error", error: "Render não encontrado" });
  res.json(job);
});

app.listen(PORT, "0.0.0.0", () => console.log(`Render server rodando na porta ${PORT}`));
