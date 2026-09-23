const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.RENDER_SERVER_TOKEN || "";

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "video-render-server"
  });
});

app.post("/render", async (req, res) => {
  try {
    const auth = req.headers.authorization;

    if (TOKEN && auth !== `Bearer ${TOKEN}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { scenes, format, resolution } = req.body;

    if (!scenes || !Array.isArray(scenes)) {
      return res.status(400).json({
        error: "scenes é obrigatório"
      });
    }

    const renderId = Date.now().toString();

    console.log("Render recebido:", renderId);
    console.log("Cenas:", scenes.length);

    /*
      A renderização FFmpeg será implementada aqui.
      Primeiro estamos validando a comunicação
      entre o Base44 e o servidor.
    */

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
  res.json({
    render_id: req.params.id,
    status: "processing",
    progress: 0
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render server rodando na porta ${PORT}`);
});
