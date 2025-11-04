"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Message = { sender: string; text: string };

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:5000";

/** STUN servers (add TURN later if needed) */
const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

function ChatContent() {
  const params = useSearchParams();
  const interest = params.get("interest") || "Random";

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState("Searching for a partner...");
  const [connected, setConnected] = useState(false);

  const [videoOn, setVideoOn] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);

  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const partnerIdRef = useRef<string | null>(null);

  useEffect(() => {
    const socket = io(BACKEND, { autoConnect: false });
    socketRef.current = socket;
    socket.connect();

    socket.emit("find_partner", interest);

    socket.on("waiting", () => setStatus("Waiting for another user with same interest..."));

    socket.on("partner_found", (partnerId: string) => {
      partnerIdRef.current = partnerId;
      setConnected(true);
      setStatus(`Connected! Chatting about "${interest}"`);
    });

    socket.on("receive_message", (data: { sender: string; text: string }) => {
      setMessages((prev) => [...prev, data]);
    });

    socket.on("offer", async (data: { from: string; offer: RTCSessionDescriptionInit }) => {
      partnerIdRef.current = data.from;
      try {
        await ensureLocalStream();
        await createPeerConnection(false);
        await pcRef.current?.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pcRef.current?.createAnswer();
        await pcRef.current?.setLocalDescription(answer!);
        socket.emit("answer", { to: data.from, answer });
        setVideoOn(true);
      } catch (err) {
        console.error("Error handling offer:", err);
      }
    });

    socket.on("answer", async (data: { from: string; answer: RTCSessionDescriptionInit }) => {
      if (pcRef.current && data.answer) {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    socket.on("ice-candidate", async (data: { from: string; candidate: RTCIceCandidateInit }) => {
      if (pcRef.current && data.candidate) {
        try {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (err) {
          console.warn("Add ICE candidate failed", err);
        }
      }
    });

    socket.on("stop_video", () => {
      cleanupPeer();
      setVideoOn(false);
    });

    socket.on("partner_disconnected", () => {
      cleanupPeer();
      setStatus("Partner disconnected");
      setConnected(false);
      setVideoOn(false);
    });

    return () => {
      try {
        socket.emit("leaveChat");
      } catch {}
      socket.disconnect();
      cleanupPeer();
    };
  }, [interest]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    if (!message.trim()) return;
    const payload: Message = { sender: "me", text: message };
    socketRef.current?.emit("send_message", payload);
    setMessages((prev) => [...prev, payload]);
    setMessage("");
  };

  async function ensureLocalStream() {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = micOn));
      localStreamRef.current.getVideoTracks().forEach((t) => (t.enabled = camEnabled));
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    stream.getAudioTracks().forEach((t) => (t.enabled = micOn));
    stream.getVideoTracks().forEach((t) => (t.enabled = camEnabled));
  }

  async function createPeerConnection(isCaller = true) {
    if (pcRef.current) return;

    const pc = new RTCPeerConnection(ICE_CONFIG);
    pcRef.current = pc;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => pc.addTrack(track, localStreamRef.current!));
    }

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && partnerIdRef.current) {
        socketRef.current?.emit("ice-candidate", {
          to: partnerIdRef.current,
          candidate: event.candidate,
        });
      }
    };

    if (isCaller && partnerIdRef.current) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socketRef.current?.emit("offer", { to: partnerIdRef.current, offer });
    }
  }

  async function startVideo() {
    try {
      await ensureLocalStream();
      await createPeerConnection(true);
      setVideoOn(true);
    } catch (err) {
      console.error("startVideo error:", err);
    }
  }

  function stopVideo() {
    socketRef.current?.emit("stop_video");
    cleanupPeer();
    setVideoOn(false);
  }

  function cleanupPeer() {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }

  async function toggleMic() {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => (t.enabled = !t.enabled));
      setMicOn((m) => !m);
    } else {
      setMicOn((m) => !m);
    }
  }

  async function toggleCamera() {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((t) => (t.enabled = !t.enabled));
      setCamEnabled((c) => !c);
    } else {
      setCamEnabled((c) => !c);
    }
  }

  return (
    <main className="flex flex-col h-screen bg-gradient-to-br from-[#0C2B4E] via-[#1A3D64] to-[#1D546C] text-white relative overflow-hidden">
      <motion.div
        className="absolute inset-0 opacity-30 bg-[radial-gradient(ellipse_at_top_left,_var(--tw-gradient-stops))] from-[#1D546C] via-transparent to-[#0C2B4E]"
        animate={{ opacity: [0.25, 0.4, 0.25] }}
        transition={{ repeat: Infinity, duration: 6, ease: "easeInOut" }}
      />

      {/* Header */}
      <motion.div
        initial={{ y: -40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 flex items-center justify-between p-4 text-lg sm:text-xl font-semibold bg-gradient-to-r from-[#0C2B4E]/80 via-[#1A3D64]/80 to-[#1D546C]/80 backdrop-blur-md shadow-md border-b border-[#F4F4F4]/10"
      >
        <div className="flex items-center gap-3">
          <span className="animate-pulse text-[#F4F4F4]">💬🎥</span>
          <div className="tracking-wide">{connected ? `Chatting about "${interest}"` : status}</div>
        </div>

        <div className="flex gap-2 items-center">
          <Button onClick={() => (videoOn ? stopVideo() : startVideo())} className="bg-[#F4F4F4] text-[#0C2B4E]">
            {videoOn ? "Stop Video" : "Start Video"}
          </Button>
          <Button onClick={toggleMic} className="bg-white/10">
            {micOn ? "Mute" : "Unmute"}
          </Button>
          <Button onClick={toggleCamera} className="bg-white/10">
            {camEnabled ? "Camera Off" : "Camera On"}
          </Button>
        </div>
      </motion.div>

      {/* Video */}
      <div className="relative z-10 p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-56 object-cover rounded-lg bg-black" />
        <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-56 object-cover rounded-lg bg-black" />
      </div>

      {/* Chat */}
      <div className="relative z-10 flex-1 overflow-y-auto p-4 space-y-3">
        <AnimatePresence>
          {messages.map((msg, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.25 }}
              className={`max-w-[75%] p-3 rounded-2xl shadow-md break-words ${
                msg.sender === "me"
                  ? "bg-[#F4F4F4] text-[#0C2B4E] self-end ml-auto"
                  : "bg-white/10 border border-white/20 text-[#F4F4F4]"
              }`}
            >
              {msg.text}
            </motion.div>
          ))}
        </AnimatePresence>
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="relative z-10 p-4 flex gap-2 border-t border-[#F4F4F4]/20 bg-white/5 backdrop-blur-md">
        <Input
          type="text"
          placeholder={connected ? "Type a message..." : "Waiting for partner..."}
          value={message}
          disabled={!connected}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          className="flex-1 bg-white/90 text-black rounded-lg"
        />
        <Button onClick={handleSend} disabled={!connected} className="bg-[#F4F4F4] text-[#0C2B4E]">
          Send
        </Button>
      </div>
    </main>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="text-center p-8 text-white">Loading chat...</div>}>
      <ChatContent />
    </Suspense>
  );
}
