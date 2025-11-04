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
interface WaitingUser {
  socketId: string;
  interests: string[];
  joinedAt: number; // timestamp for FIFO when interests match equally
}

const waitingUsers: WaitingUser[] = []; // Array of waiting users with their interests
const activePairs: Record<string, string> = {}; // { socketId: partnerSocketId }
const userInterests: Record<string, string[]> = {}; // { socketId: [interests] }

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

    // Helper function to parse interests
    const parseInterests = (interestInput: string | string[]): string[] => {
      if (Array.isArray(interestInput)) {
        return interestInput.filter(i => i && i.trim() !== "");
      }
      if (typeof interestInput === "string") {
        if (interestInput.trim() === "" || interestInput.toLowerCase() === "random") {
          return ["Random"];
        }
        return interestInput
          .split(",")
          .map(i => i.trim())
          .filter(i => i !== "")
          .map(i => i.toLowerCase());
      }
      return ["Random"];
    };

    // Helper function to find common interests
    const findCommonInterests = (interests1: string[], interests2: string[]): string[] => {
      return interests1.filter(i => interests2.includes(i));
    };

    // Helper function to find best matching partner
    const findBestMatch = (userInterests: string[], excludeSocketId: string): WaitingUser | null => {
      let bestMatch: WaitingUser | null = null;
      let maxCommonInterests = 0;
      let earliestTimestamp = Infinity;

      for (const waitingUser of waitingUsers) {
        if (waitingUser.socketId === excludeSocketId) continue;

        const common = findCommonInterests(userInterests, waitingUser.interests);
        const commonCount = common.length;

        // Skip if no common interests (unless both are Random)
        const bothRandom = 
          userInterests.includes("random") && waitingUser.interests.includes("random");
        
        if (commonCount === 0 && !bothRandom) continue;

        // Prefer user with most common interests
        if (commonCount > maxCommonInterests) {
          maxCommonInterests = commonCount;
          bestMatch = waitingUser;
          earliestTimestamp = waitingUser.joinedAt;
        } 
        // If same number of common interests, prefer earliest joiner (FIFO)
        else if (commonCount === maxCommonInterests && waitingUser.joinedAt < earliestTimestamp) {
          bestMatch = waitingUser;
          earliestTimestamp = waitingUser.joinedAt;
        }
      }

      return bestMatch;
    };

    // Client asks to find a partner for interests
    socket.on("find_partner", (interestInput: string | string[]) => {
      // Parse interests
      const interests = parseInterests(interestInput);
      userInterests[socket.id] = interests;

      // Remove user from waiting list if already there
      const existingIndex = waitingUsers.findIndex(u => u.socketId === socket.id);
      if (existingIndex !== -1) {
        waitingUsers.splice(existingIndex, 1);
      }

      // Try to find best matching partner
      const bestMatch = findBestMatch(interests, socket.id);

      if (bestMatch) {
        // Remove both users from waiting list
        const matchIndex = waitingUsers.findIndex(u => u.socketId === bestMatch.socketId);
        if (matchIndex !== -1) {
          waitingUsers.splice(matchIndex, 1);
        }

        // Set active pair both ways
        activePairs[socket.id] = bestMatch.socketId;
        activePairs[bestMatch.socketId] = socket.id;

        const commonInterests = findCommonInterests(interests, bestMatch.interests);
        const commonStr = commonInterests.length > 0 
          ? commonInterests.join(", ") 
          : "Random";

        io.to(socket.id).emit("partner_found", bestMatch.socketId);
        io.to(bestMatch.socketId).emit("partner_found", socket.id);

        console.log(`🤝 Matched ${socket.id} ↔ ${bestMatch.socketId} (common: ${commonStr})`);
      } else {
        // Add to waiting list
        waitingUsers.push({
          socketId: socket.id,
          interests: interests,
          joinedAt: Date.now()
        });
        
        const interestStr = interests.length > 0 && !interests.includes("random")
          ? interests.join(", ")
          : "Random";
        io.to(socket.id).emit("waiting", `Waiting for someone interested in: ${interestStr}...`);
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
    socket.on("skip", (interestInput: string | string[]) => {
      const partnerId = activePairs[socket.id];
      if (partnerId) {
        // Notify partner that they were skipped
        io.to(partnerId).emit("partner_disconnected");
        delete activePairs[partnerId];
      }
      // Remove from active pairs
      delete activePairs[socket.id];
      
      // Get user's interests (use stored or parse new)
      const interests = interestInput 
        ? parseInterests(interestInput) 
        : (userInterests[socket.id] || ["Random"]);
      userInterests[socket.id] = interests;

      // Remove from waiting list if present
      const existingIndex = waitingUsers.findIndex(u => u.socketId === socket.id);
      if (existingIndex !== -1) {
        waitingUsers.splice(existingIndex, 1);
      }

      // Immediately search for a new partner
      const bestMatch = findBestMatch(interests, socket.id);
      
      if (bestMatch) {
        // Found a new partner immediately
        const matchIndex = waitingUsers.findIndex(u => u.socketId === bestMatch.socketId);
        if (matchIndex !== -1) {
          waitingUsers.splice(matchIndex, 1);
        }
        
        activePairs[socket.id] = bestMatch.socketId;
        activePairs[bestMatch.socketId] = socket.id;
        
        io.to(socket.id).emit("partner_found", bestMatch.socketId);
        io.to(bestMatch.socketId).emit("partner_found", socket.id);
        
        console.log(`🔄 Skipped and matched ${socket.id} ↔ ${bestMatch.socketId}`);
      } else {
        // Add to waiting list
        waitingUsers.push({
          socketId: socket.id,
          interests: interests,
          joinedAt: Date.now()
        });
        
        const interestStr = interests.length > 0 && !interests.includes("random")
          ? interests.join(", ")
          : "Random";
        io.to(socket.id).emit("waiting", `Waiting for someone interested in: ${interestStr}...`);
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
      // Remove from waiting list
      const existingIndex = waitingUsers.findIndex(u => u.socketId === socket.id);
      if (existingIndex !== -1) {
        waitingUsers.splice(existingIndex, 1);
      }
      delete activePairs[socket.id];
      delete userInterests[socket.id];
    });

    // Handle disconnect
    socket.on("disconnect", () => {
      console.log("❌ Disconnected:", socket.id);
      const partnerId = activePairs[socket.id];
      if (partnerId) {
        io.to(partnerId).emit("partner_disconnected");
        delete activePairs[partnerId];
      }
      // Remove from waiting list
      const existingIndex = waitingUsers.findIndex(u => u.socketId === socket.id);
      if (existingIndex !== -1) {
        waitingUsers.splice(existingIndex, 1);
      }
      delete activePairs[socket.id];
      delete userInterests[socket.id];
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
