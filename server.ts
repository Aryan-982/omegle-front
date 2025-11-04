import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { Server } from "socket.io";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// In-memory pairing structures
const waitingUsers: Record<string, string[]> = {}; // { interest: [socketId, ...] }
const activePairs: Record<string, string> = {}; // { socketId: partnerSocketId }

app.prepare().then(() => {
  const httpServer = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error occurred handling", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("✅ Connected:", socket.id);

    // Client asks to find a partner for an interest
    socket.on("find_partner", (interest: string) => {
      if (!interest) interest = "Random";
      if (!waitingUsers[interest]) waitingUsers[interest] = [];

      // Try to find partner who is waiting (not same socket)
      const partnerId = waitingUsers[interest].find((id) => id !== socket.id);

      if (partnerId) {
        // Remove partner from waiting list
        waitingUsers[interest] = waitingUsers[interest].filter((id) => id !== partnerId);

        // Set active pair both ways
        activePairs[socket.id] = partnerId;
        activePairs[partnerId] = socket.id;

        io.to(socket.id).emit("partner_found", partnerId);
        io.to(partnerId).emit("partner_found", socket.id);

        console.log(`🤝 Matched ${socket.id} ↔ ${partnerId}`);
      } else {
        // Add to waiting list if not present
        if (!waitingUsers[interest].includes(socket.id)) {
          waitingUsers[interest].push(socket.id);
        }
        io.to(socket.id).emit("waiting", "Waiting for another user...");
      }
    });

    // Text message relay
    socket.on("send_message", (data: { text: string }) => {
      const partnerId = activePairs[socket.id];
      if (partnerId) {
        // Send to partner
        io.to(partnerId).emit("receive_message", { sender: "partner", text: data.text });
        // Echo back to sender
        io.to(socket.id).emit("receive_message", { sender: "me", text: data.text });
      }
    });

    // WebRTC Signaling (offer/answer/ice)
    socket.on("offer", ({ offer }: { offer: RTCSessionDescriptionInit }) => {
      const partnerId = activePairs[socket.id];
      if (partnerId) {
        io.to(partnerId).emit("offer", { from: socket.id, offer });
      }
    });

    socket.on("answer", ({ to, answer }: { to: string; answer: RTCSessionDescriptionInit }) => {
      if (to) {
        io.to(to).emit("answer", { from: socket.id, answer });
      }
    });

    socket.on("ice-candidate", ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      const partnerId = activePairs[socket.id];
      if (partnerId) {
        io.to(partnerId).emit("ice-candidate", { from: socket.id, candidate });
      }
    });

    // Partner wants to stop video (forward)
    socket.on("stop_video", () => {
      const partnerId = activePairs[socket.id];
      if (partnerId) {
        io.to(partnerId).emit("stop_video");
      }
    });

    // User wants to skip current partner
    socket.on("skip", (interest: string) => {
      const partnerId = activePairs[socket.id];
      if (partnerId) {
        // Notify partner that they were skipped
        io.to(partnerId).emit("partner_disconnected");
        delete activePairs[partnerId];
      }
      // Remove from active pairs
      delete activePairs[socket.id];
      
      // Remove from waiting lists
      for (const interestKey in waitingUsers) {
        waitingUsers[interestKey] = waitingUsers[interestKey].filter((id) => id !== socket.id);
      }
      
      // Immediately search for a new partner
      if (!interest) interest = "Random";
      if (!waitingUsers[interest]) waitingUsers[interest] = [];
      
      const newPartnerId = waitingUsers[interest].find((id) => id !== socket.id);
      
      if (newPartnerId) {
        // Found a new partner immediately
        waitingUsers[interest] = waitingUsers[interest].filter((id) => id !== newPartnerId);
        activePairs[socket.id] = newPartnerId;
        activePairs[newPartnerId] = socket.id;
        
        io.to(socket.id).emit("partner_found", newPartnerId);
        io.to(newPartnerId).emit("partner_found", socket.id);
        
        console.log(`🔄 Skipped and matched ${socket.id} ↔ ${newPartnerId}`);
      } else {
        // Add to waiting list
        if (!waitingUsers[interest].includes(socket.id)) {
          waitingUsers[interest].push(socket.id);
        }
        io.to(socket.id).emit("waiting", "Waiting for another user...");
        console.log(`⏭️ Skipped: ${socket.id} waiting for new partner`);
      }
    });

    // Optional: partner left chat
    socket.on("leaveChat", () => {
      const partnerId = activePairs[socket.id];
      if (partnerId) {
        io.to(partnerId).emit("partner_disconnected");
        delete activePairs[partnerId];
      }
      // Remove from waiting lists
      for (const interest in waitingUsers) {
        waitingUsers[interest] = waitingUsers[interest].filter((id) => id !== socket.id);
      }
      delete activePairs[socket.id];
    });

    // Handle disconnect
    socket.on("disconnect", () => {
      console.log("❌ Disconnected:", socket.id);
      const partnerId = activePairs[socket.id];
      if (partnerId) {
        io.to(partnerId).emit("partner_disconnected");
        delete activePairs[partnerId];
      }
      for (const interest in waitingUsers) {
        waitingUsers[interest] = waitingUsers[interest].filter((id) => id !== socket.id);
      }
      delete activePairs[socket.id];
    });
  });

  httpServer
    .once("error", (err) => {
      console.error(err);
      process.exit(1);
    })
    .listen(port, () => {
      console.log(`🚀 Server ready on http://${hostname}:${port}`);
      console.log(`📡 Socket.io server integrated`);
    });
});
