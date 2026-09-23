const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const app = express();

app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.RENDER_SERVER_TOKEN || "";

const BASE_DIR = "/tmp/video-render";
const OUTPUT_DIR = path.join(BASE_DIR, "output");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const jobs = new Map();

function createId() {
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

function getResolution(resolution, format) {
  if (typeof resolution === "string" && resolution.includes("x")) {
    const [w, h] = resolution.split("x").map(Number);

    if (Number.isFinite(w) && Number.isFinite(h)) {
      return { width: w, height: h };
    }
  }

  if (format === "9:16") {
    return { width: 1080, height: 1920 };
  }

  if (format === "1:1") {
    return { width: 1080, height: 1080 };
  }

  return { width: 1920, height: 1080 };
}

function auth(req, res) {
  if (!TOKEN) return true;

  const authorization = req.headers.authorization || "";

  if (authorization !== `Bearer ${TOKEN}`) {
    res.status(401).json({
      status: "error",
      error: "Unauthorized"
    });

    return false;
  }

  return true;
}

async function downloadFile(url, destination) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Não foi possível baixar o arquivo: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  fs.writeFileSync(destination, buffer);

  return destination;
}

async function getMediaType(file) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file
    ]);

    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function escapeTextFile(text) {
  return String(text || "").replace(/\r/g, "").trim();
}

async function createScene(scene, index, workDir, width, height) {
  if (!scene || !scene.asset_url) {
    throw new Error(`Cena ${index + 1} não possui asset_url`);
  }

  const duration = Math.max(
    0.5,
    Number(scene.duration) || 3
  );

  const inputFile = path.join(workDir, `input-${index}`);
  const outputFile = path.join(workDir, `scene-${index}.mp4`);

  await downloadFile(scene.asset_url, inputFile);

  const mediaType = await getMediaType(inputFile);

  const filters = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`,
    "setsar=1",
    "fps=30"
  ];

  const onScreenText = escapeTextFile(scene.on_screen_text);
  const caption = escapeTextFile(scene.caption);

  const filterFiles = [];

  if (onScreenText) {
    const textFile = path.join(workDir, `text-${index}.txt`);
    fs.writeFileSync(textFile, onScreenText, "utf8");
    filterFiles.push(textFile);

    filters.push(
      `drawtext=textfile='${textFile}':fontcolor=white:fontsize=64:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:box=1:boxcolor=black@0.55:boxborderw=20:x=(w-text_w)/2:y=h*0.15`
    );
  }

  if (caption) {
    const captionFile = path.join(workDir, `caption-${index}.txt`);
    fs.writeFileSync(captionFile, caption, "utf8");
    filterFiles.push(captionFile);

    filters.push(
      `drawtext=textfile='${captionFile}':fontcolor=white:fontsize=42:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:box=1:boxcolor=black@0.65:boxborderw=15:x=(w-text_w)/2:y=h*0.82`
    );
  }

  const filter = filters.join(",");

  if (mediaType === "video") {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      inputFile,
      "-t",
      String(duration),
      "-vf",
      filter,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputFile
    ]);
  } else {
    await execFileAsync("ffmpeg", [
      "-y",
      "-loop",
      "1",
      "-i",
      inputFile,
      "-t",
      String(duration),
      "-vf",
      filter,
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputFile
    ]);
  }

  return {
    file: outputFile,
    duration
  };
}

async function concatScenes(sceneFiles, outputFile) {
  const listFile = path.join(
    path.dirname(outputFile),
    "concat.txt"
  );

  const content = sceneFiles
    .map(file => `file '${file.replace(/'/g, "'\\''")}'`)
    .join("\n");

  fs.writeFileSync(listFile, content, "utf8");

  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outputFile
  ]);
}

async function processRender(renderId, requestBody, publicBaseUrl) {
  const workDir = path.join(BASE_DIR, renderId);

  fs.mkdirSync(workDir, { recursive: true });

  try {
    jobs.set(renderId, {
      render_id: renderId,
      status: "processing",
      progress: 0
    });

    const scenes = requestBody.scenes || [];

    const { width, height } = getResolution(
      requestBody.resolution,
      requestBody.format
    );

    const sceneFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = await createScene(
        scenes[i],
        i,
        workDir,
        width,
        height
      );

      sceneFiles.push(scene.file);

      jobs.set(renderId, {
        render_id: renderId,
        status: "processing",
        progress: Math.round(((i + 1) / scenes.length) * 90)
      });
    }

    const outputFile = path.join(
      OUTPUT_DIR,
      `${renderId}.mp4`
    );

    await concatScenes(sceneFiles, outputFile);

    jobs.set(renderId, {
      render_id: renderId,
      status: "completed",
      progress: 100,
      render_url: `${publicBaseUrl}/output/${renderId}.mp4`
    });

    fs.rmSync(workDir, {
      recursive: true,
      force: true
    });

  } catch (error) {
    console.error("Erro no render:", error);

    jobs.set(renderId, {
      render_id: renderId,
      status: "error",
      progress: 0,
      error: error.message
    });

    fs.rmSync(workDir, {
      recursive: true,
      force: true
    });
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "video-render-server",
    ffmpeg: true
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok"
  });
});

app.use("/output", express.static(OUTPUT_DIR));

app.post("/render", async (req, res) => {
  if (!auth(req, res)) return;

  try {
    const { scenes } = req.body;

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({
        status: "error",
        error: "scenes é obrigatório e deve conter pelo menos uma cena"
      });
    }

    const renderId = createId();

    const protocol =
      req.headers["x-forwarded-proto"] || "https";

    const host = req.get("host");

    const publicBaseUrl = `${protocol}://${host}`;

    jobs.set(renderId, {
      render_id: renderId,
      status: "processing",
      progress: 0
    });

    processRender(
      renderId,
      req.body,
      publicBaseUrl
    );

    return res.json({
      render_id: renderId,
      status: "processing",
      progress: 0
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      status: "error",
      error: error.message
    });
  }
});

app.get("/render/:id", (req, res) => {
  if (!auth(req, res)) return;

  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      status: "error",
      error: "Render não encontrado"
    });
  }

  res.json(job);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Render server rodando na porta ${PORT}`
  );
});
