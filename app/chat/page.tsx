"use client";

import { useSearchParams } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import io from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const socket = io("http://localhost:5000"); // 👈 change if backend on another URL

export default function ChatPage() {
  const params = useSearchParams();
  const interest = params.get("interest") || "Random";
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<{ sender: string; text: string }[]>([]);
  const [status, setStatus] = useState("Searching for a partner...");
  const [connected, setConnected] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Join room based on interest
  socket.emit("find_partner", interest);

    // Waiting status
    socket.on("waiting", () => {
      setStatus("Waiting for another user with same interest...");
    });

    // Connected to partner
    socket.on("partner_found", () => {
      setConnected(true);
      setStatus(`Connected! You’re chatting about "${interest}"`);
    });

    // Receive messages
    socket.on("receive_message", (data) => {
      // data should be { sender, text }
      setMessages((prev) => [...prev, { sender: data.sender, text: data.text }]);
    });

    // Cleanup on unmount
    return () => {
  socket.emit("leaveChat");
      socket.off("waiting");
      socket.off("partnerFound");
      socket.off("message");
    };
  }, [interest]);

  const handleSend = () => {
    if (!message.trim()) return;
    // Send both sender and text to backend
    socket.emit("send_message", { sender: "me", text: message });
    setMessage("");
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <main className="flex flex-col h-screen bg-gradient-to-br from-[#0C2B4E] via-[#1A3D64] to-[#1D546C] text-white relative overflow-hidden">
      {/* Animated glowing gradient */}
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
        className="relative z-10 flex items-center justify-center gap-3 p-4 text-lg sm:text-xl font-semibold bg-gradient-to-r from-[#0C2B4E]/80 via-[#1A3D64]/80 to-[#1D546C]/80 backdrop-blur-md shadow-md border-b border-[#F4F4F4]/10"
      >
        <span className="animate-pulse text-[#F4F4F4]">💬</span>
        <span className="tracking-wide">
          {connected ? (
            <>
              Chatting about{" "}
              <span className="font-bold text-[#F4F4F4] underline decoration-[#F4F4F4]/40">
                {interest}
              </span>
            </>
          ) : (
            status
          )}
        </span>
      </motion.div>

      {/* Messages */}
      <div className="relative z-10 flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-thumb-[#F4F4F4]/20 scrollbar-track-transparent">
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

      {/* Input Area */}
      <div className="relative z-10 p-4 flex gap-2 border-t border-[#F4F4F4]/20 bg-white/5 backdrop-blur-md">
        <Input
          type="text"
          placeholder={connected ? "Type a message..." : "Waiting for partner..."}
          value={message}
          disabled={!connected}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          className="flex-1 bg-white/90 text-black rounded-lg placeholder:text-gray-500 focus:ring-2 focus:ring-[#1A3D64]/60"
        />
        <Button
          onClick={handleSend}
          disabled={!connected}
          className="bg-[#F4F4F4] text-[#0C2B4E] font-semibold hover:bg-[#1A3D64] hover:text-white transition-all duration-300 rounded-lg px-5 disabled:opacity-40"
        >
          Send
        </Button>
      </div>
    </main>
  );
}
