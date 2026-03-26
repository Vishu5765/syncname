import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import multer from "multer";
import fs from "fs";

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  // Increase server timeouts for large file uploads
  httpServer.timeout = 600000; // 10 minutes
  httpServer.keepAliveTimeout = 600000;

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

  // Increase limit to 100MB for robust uploads
  const upload = multer({ 
    storage,
    limits: { fileSize: 100 * 1024 * 1024 } 
  });

  // Serve static files from public
  app.use("/uploads", express.static(uploadsDir));

  // File Upload Endpoint
  app.post("/api/upload", (req, res) => {
    upload.single("audio")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        console.error("Multer Error:", err);
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      } else if (err) {
        console.error("Unknown Upload Error:", err);
        return res.status(500).json({ error: "Unknown upload error" });
      }

      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      console.log(`File uploaded successfully: ${file.filename} (${file.size} bytes)`);
      const fileUrl = `/uploads/${file.filename}`;
      res.json({ url: fileUrl });
    });
  });

  // Room storage
  const rooms = new Map<string, { 
    hostId: string; 
    locked: boolean; 
    audioState: any; 
    users: Map<string, string>; 
    banned: Set<string>;
    library: string[];
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
        banned: new Set(),
        library: []
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
      socket.emit("joined-room", { 
        roomKey, 
        username: room.users.get(socket.id),
        audioState: room.audioState 
      });
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
    socket.on("play-audio", ({ roomKey, audioUrl, offset, loop }) => {
      const room = rooms.get(roomKey);
      if (room && room.hostId === socket.id) {
        const startTime = Date.now() + 2000; // Server-side sync point
        room.audioState = { audioUrl, startTime, offset, playing: true, loop: !!loop };
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

    socket.on("seek-audio", ({ roomKey, offset, loop }) => {
      const room = rooms.get(roomKey);
      if (room && room.hostId === socket.id) {
        const startTime = Date.now() + 500; // Short delay for seek
        if (room.audioState) {
          room.audioState.offset = offset;
          room.audioState.startTime = startTime;
          if (loop !== undefined) room.audioState.loop = loop;
        }
        io.to(roomKey).emit("audio-seek", { offset, startTime, loop: room.audioState?.loop });
      }
    });

    socket.on("add-to-library", ({ roomKey, url }) => {
      const room = rooms.get(roomKey);
      if (room && room.hostId === socket.id) {
        if (!room.library.includes(url)) {
          room.library.push(url);
        }
        socket.emit("library-update", room.library);
      }
    });

    socket.on("remove-from-library", ({ roomKey, url }) => {
      const room = rooms.get(roomKey);
      if (room && room.hostId === socket.id) {
        room.library = room.library.filter(item => item !== url);
        socket.emit("library-update", room.library);
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
