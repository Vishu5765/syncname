import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import ytdl from "@distube/ytdl-core";
import multer from "multer";
import fs from "fs";
import { Readable } from "stream";

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const PORT = 3000;

  // Setup Uploads Directory
  const uploadsDir = path.join(process.cwd(), "public", "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + "-" + file.originalname);
    },
  });
  const upload = multer({ storage });

  // Serve static files from public
  app.use("/uploads", express.static(uploadsDir));

  // File Upload Endpoint
  app.post("/api/upload", upload.single("audio"), (req, res) => {
    const file = (req as any).file;
    if (!file) return res.status(400).send("No file uploaded");
    const fileUrl = `/uploads/${file.filename}`;
    res.json({ url: fileUrl });
  });

  // Audio Proxy (YouTube, Freefy, etc.)
  app.get("/api/stream/audio", async (req, res) => {
    const url = req.query.url as string;
    if (!url) return res.status(400).send("No URL provided");
    
    console.log(`Attempting to stream audio: ${url}`);
    
    try {
      if (url.includes("youtube.com") || url.includes("youtu.be")) {
        if (!ytdl.validateURL(url)) {
          return res.status(400).send("Invalid YouTube URL");
        }

        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Transfer-Encoding", "chunked");

        const stream = ytdl(url, { 
          filter: "audioonly", 
          quality: "highestaudio",
          highWaterMark: 1 << 25 // 32MB buffer to prevent stuttering
        });

        stream.on("error", (err) => {
          console.error("ytdl stream error:", err);
          if (!res.headersSent) res.status(500).send("Stream error");
        });

        stream.pipe(res);
      } else {
        // General proxy for other audio sources (Freefy, direct links, etc.)
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const contentType = response.headers.get("content-type");
        if (contentType) res.setHeader("Content-Type", contentType);
        
        if (response.body) {
          // @ts-ignore
          Readable.fromWeb(response.body).pipe(res);
        } else {
          res.status(500).send("Empty response body");
        }
      }
    } catch (err) {
      console.error("Audio Proxy Error:", err);
      if (!res.headersSent) res.status(500).send("Failed to stream audio");
    }
  });

  // Room storage
  const rooms = new Map<string, { 
    hostId: string; 
    locked: boolean; 
    audioState: any; 
    users: Map<string, string>; 
    banned: Set<string>;
  }>();

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // NTP-style clock sync
    socket.on("sync-request", (clientTimestamp) => {
      socket.emit("sync-response", {
        clientTimestamp,
        serverTimestamp: Date.now(),
      });
    });

    // Create Room
    socket.on("create-room", (username) => {
      let roomKey = Math.floor(1000 + Math.random() * 9000).toString();
      while (rooms.has(roomKey)) {
        roomKey = Math.floor(1000 + Math.random() * 9000).toString();
      }
      const users = new Map<string, string>();
      users.set(socket.id, username || "Host");
      rooms.set(roomKey, { 
        hostId: socket.id, 
        locked: false, 
        audioState: null, 
        users, 
        banned: new Set() 
      });
      socket.join(roomKey);
      socket.emit("room-created", { roomKey, username: username || "Host" });
      io.to(roomKey).emit("user-list", Array.from(users.entries()));
      console.log(`Room created: ${roomKey} by ${username} (${socket.id})`);
    });

    // Join Room
    socket.on("join-room", ({ roomKey, username }) => {
      const room = rooms.get(roomKey);
      if (!room) {
        socket.emit("error", "Room not found");
        return;
      }
      if (room.locked) {
        socket.emit("error", "Room is locked");
        return;
      }
      if (room.banned.has(socket.id)) {
        socket.emit("killed", "You are killed by host");
        return;
      }
      room.users.set(socket.id, username || `User-${socket.id.slice(0, 4)}`);
      socket.join(roomKey);
      socket.emit("joined-room", { roomKey, username: room.users.get(socket.id) });
      io.to(roomKey).emit("user-list", Array.from(room.users.entries()));
      console.log(`User ${username} joined room ${roomKey}`);
    });

    // Kill User
    socket.on("kill-user", ({ roomKey, targetId }) => {
      const room = rooms.get(roomKey);
      if (room && room.hostId === socket.id) {
        if (targetId === socket.id) return; // Can't kill self
        room.banned.add(targetId);
        room.users.delete(targetId);
        io.to(targetId).emit("killed", "You are killed by host");
        io.to(roomKey).emit("user-list", Array.from(room.users.entries()));
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) targetSocket.leave(roomKey);
      }
    });

    // Lock Room
    socket.on("lock-room", (roomKey) => {
      const room = rooms.get(roomKey);
      if (room && room.hostId === socket.id) {
        room.locked = !room.locked;
        io.to(roomKey).emit("room-lock-status", room.locked);
      }
    });

    // Audio Sync Events
    socket.on("play-audio", ({ roomKey, audioUrl, startTime, offset, loop }) => {
      const room = rooms.get(roomKey);
      if (room && room.hostId === socket.id) {
        let finalUrl = audioUrl;
        if (audioUrl.includes("youtube.com") || audioUrl.includes("youtu.be") || audioUrl.includes("freefy.app")) {
          finalUrl = `/api/stream/audio?url=${encodeURIComponent(audioUrl)}`;
        }
        room.audioState = { audioUrl: finalUrl, startTime, offset, playing: true, loop: !!loop };
        io.to(roomKey).emit("audio-play", room.audioState);
      }
    });

    socket.on("pause-audio", (roomKey) => {
      const room = rooms.get(roomKey);
      if (room && room.hostId === socket.id) {
        if (room.audioState) room.audioState.playing = false;
        io.to(roomKey).emit("audio-pause");
      }
    });

    socket.on("seek-audio", ({ roomKey, offset, startTime, loop }) => {
      const room = rooms.get(roomKey);
      if (room && room.hostId === socket.id) {
        if (room.audioState) {
          room.audioState.offset = offset;
          room.audioState.startTime = startTime;
          if (loop !== undefined) room.audioState.loop = loop;
        }
        io.to(roomKey).emit("audio-seek", { offset, startTime, loop: room.audioState?.loop });
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      for (const [key, room] of rooms.entries()) {
        if (room.users.has(socket.id)) {
          room.users.delete(socket.id);
          io.to(key).emit("user-list", Array.from(room.users.entries()));
        }
        if (room.hostId === socket.id) {
          io.to(key).emit("error", "Host disconnected");
          rooms.delete(key);
        }
      }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
