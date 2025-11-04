"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkipForward } from "lucide-react";

type Message = { sender: string; text: string };

// Connect to the same Next.js server (Socket.io is integrated)
const BACKEND = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";

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
        try {
          await pcRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
        } catch (err) {
          console.error("Error setting remote description (answer):", err);
        }
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
      setStatus("Partner disconnected. Searching for a new partner...");
      setConnected(false);
      setVideoOn(false);
      setMessages([]);
      // Auto-reconnect to find new partner
      setTimeout(() => {
        socket.emit("find_partner", interest);
      }, 1000);
    });

    return () => {
      try {
        socket.emit("leaveChat");
      } catch {}
      socket.disconnect();
      
      // Only stop tracks when component unmounts (tab closes)
      // This is safe because the tab is closing
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
      
      cleanupPeer();
    };
  }, [interest]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    if (!message.trim()) return;
    const text = message.trim();
    setMessage("");
    // Send message to server - it will echo back via receive_message event
    socketRef.current?.emit("send_message", { text });
  };

  const handleSkip = () => {
    if (socketRef.current && connected) {
      socketRef.current.emit("skip", interest);
      setMessages([]);
      setConnected(false);
      setVideoOn(false);
      cleanupPeer();
      setStatus("Skipping... Searching for a new partner...");
    }
  };

  async function ensureLocalStream() {
    // Check if stream exists and is still active
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      const audioTracks = localStreamRef.current.getAudioTracks();
      
      // Check if any tracks ended (e.g., another tab took control)
      const allTracksEnded = 
        (videoTracks.length === 0 || videoTracks.every(t => t.readyState === 'ended')) &&
        (audioTracks.length === 0 || audioTracks.every(t => t.readyState === 'ended'));
      
      if (allTracksEnded) {
        // Stream was ended by browser (likely another tab), create new one
        console.log("Stream ended unexpectedly, requesting new stream");
        localStreamRef.current = null;
      } else {
        // Stream is still active, just update track states
        audioTracks.forEach((t) => {
          if (t.readyState === 'live') {
            t.enabled = micOn;
          }
        });
        videoTracks.forEach((t) => {
          if (t.readyState === 'live') {
            t.enabled = camEnabled;
          }
        });
        return;
      }
    }

    // Try to get both video and audio first
    let stream: MediaStream | null = null;
    let gotVideo = false;
    let gotAudio = false;

    try {
      // Try to get both at once
      const constraints: MediaStreamConstraints = {
        video: camEnabled ? {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        } : false,
        audio: micOn ? {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } : false
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      gotVideo = stream.getVideoTracks().length > 0;
      gotAudio = stream.getAudioTracks().length > 0;
    } catch (error: any) {
      console.warn("Failed to get both video and audio, trying separately:", error);
      
      // If that fails, try video and audio separately
      try {
        if (camEnabled) {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ video: true });
            gotVideo = true;
          } catch (videoErr: any) {
            console.warn("Could not get video:", videoErr);
            if (videoErr.name === 'NotFoundError' || videoErr.name === 'DevicesNotFoundError') {
              setCamEnabled(false);
            }
          }
        }

        if (micOn && (!stream || stream.getAudioTracks().length === 0)) {
          try {
            const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (stream) {
              audioStream.getAudioTracks().forEach(track => stream!.addTrack(track));
            } else {
              stream = audioStream;
            }
            gotAudio = true;
          } catch (audioErr: any) {
            console.warn("Could not get audio:", audioErr);
            if (audioErr.name === 'NotFoundError' || audioErr.name === 'DevicesNotFoundError') {
              setMicOn(false);
            }
          }
        }

        if (!stream || (!gotVideo && !gotAudio)) {
          throw new Error("Could not access any media devices");
        }
      } catch (fallbackError: any) {
        console.error("Error getting user media:", fallbackError);
        
        // Handle specific error cases
        if (fallbackError.name === 'NotFoundError' || fallbackError.name === 'DevicesNotFoundError') {
          setStatus("Camera or microphone not found. Please check your devices.");
          setCamEnabled(false);
          setMicOn(false);
        } else if (fallbackError.name === 'NotAllowedError' || fallbackError.name === 'PermissionDeniedError') {
          setStatus("Camera/microphone permission denied. Please allow access.");
          setCamEnabled(false);
          setMicOn(false);
        } else if (fallbackError.name === 'NotReadableError' || fallbackError.name === 'TrackStartError') {
          setStatus("Camera or microphone is being used by another application.");
          setCamEnabled(false);
          setMicOn(false);
        } else {
          setStatus(`Error accessing media: ${fallbackError.message || 'Unknown error'}`);
        }
        
        throw fallbackError;
      }
    }

    if (stream) {
      localStreamRef.current = stream;
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      
      // Apply user preferences to tracks
      if (stream.getAudioTracks().length > 0) {
        stream.getAudioTracks().forEach((t) => (t.enabled = micOn));
      }
      if (stream.getVideoTracks().length > 0) {
        stream.getVideoTracks().forEach((t) => (t.enabled = camEnabled));
      }
      
      // Add event listeners to detect when tracks end (e.g., another tab takes control)
      stream.getTracks().forEach(track => {
        track.addEventListener('ended', () => {
          console.log(`Track ended: ${track.kind}`, track.readyState);
          // If video track ended and we still want video, try to restore
          if (track.kind === 'video' && camEnabled) {
            console.log("Video track ended, attempting to restore...");
            // Don't auto-restore, let user click start video again
            setVideoOn(false);
            setStatus("Video disconnected. Click 'Start Video' to reconnect.");
          }
          // If audio track ended and we still want audio
          if (track.kind === 'audio' && micOn) {
            console.log("Audio track ended, attempting to restore...");
            setMicOn(false);
          }
        });
      });
    }
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
      if (partnerIdRef.current && localStreamRef.current) {
        // Check if we actually have tracks before starting
        const hasVideoTrack = localStreamRef.current.getVideoTracks().length > 0;
        const hasAudioTrack = localStreamRef.current.getAudioTracks().length > 0;
        
        if (!hasVideoTrack && !hasAudioTrack) {
          setStatus("No media devices available. Please check your camera and microphone.");
          return;
        }
        
        await createPeerConnection(true);
        setVideoOn(true);
        setStatus(connected ? `Connected! Chatting about "${interest}"` : status);
      } else if (!partnerIdRef.current) {
        setStatus("Waiting for a partner to start video...");
      }
    } catch (err: any) {
      console.error("startVideo error:", err);
      if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setStatus("Camera or microphone not found. Video disabled.");
      } else {
        setStatus(`Failed to start video: ${err.message}`);
      }
      setVideoOn(false);
    }
  }

  function stopVideo() {
    socketRef.current?.emit("stop_video");
    
    // Remove tracks from peer connection
    if (pcRef.current && localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        const sender = pcRef.current?.getSenders().find(s => 
          s.track && s.track.id === track.id
        );
        if (sender) {
          pcRef.current?.removeTrack(sender);
        }
      });
    }
    
    cleanupPeer();
    // Don't stop the tracks - just stop using them in peer connection
    // This allows the stream to be reused if user starts video again
    // And prevents interfering with other tabs
    setVideoOn(false);
  }

  function cleanupPeer() {
    // Don't stop tracks if they're still in use - just remove from peer connection
    // This prevents affecting other tabs that might be using the same devices
    if (localStreamRef.current) {
      // Remove tracks from peer connection but don't stop the stream
      // The stream will be reused if user starts video again
      const tracks = localStreamRef.current.getTracks();
      tracks.forEach(track => {
        // Only stop if explicitly stopping video, not on cleanup
        // We'll handle this in stopVideo instead
      });
      
      // Clear video element but keep stream reference for potential reuse
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
      }
    }
    
    if (pcRef.current) {
      try {
        // Close peer connection but don't stop local tracks
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }
    
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  }
  
  function stopAllTracks() {
    // Only call this when explicitly stopping video
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => {
        t.stop();
      });
      localStreamRef.current = null;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
      }
    }
  }

  async function toggleMic() {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      if (audioTracks.length > 0) {
        const newState = !micOn;
        audioTracks.forEach((t) => (t.enabled = newState));
        setMicOn(newState);
      } else {
        // Try to get audio if we don't have it
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (localStreamRef.current) {
            audioStream.getAudioTracks().forEach(track => {
              localStreamRef.current!.addTrack(track);
              track.enabled = !micOn;
            });
            setMicOn(!micOn);
          }
        } catch (err: any) {
          console.error("Could not enable microphone:", err);
          setStatus("Microphone not available");
          setMicOn(false);
        }
      }
    } else {
      setMicOn((m) => !m);
    }
  }

  async function toggleCamera() {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      if (videoTracks.length > 0) {
        const newState = !camEnabled;
        videoTracks.forEach((t) => (t.enabled = newState));
        setCamEnabled(newState);
      } else {
        // Try to get video if we don't have it
        try {
          const videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
          if (localStreamRef.current) {
            videoStream.getVideoTracks().forEach(track => {
              localStreamRef.current!.addTrack(track);
              track.enabled = !camEnabled;
              if (localVideoRef.current) {
                localVideoRef.current.srcObject = localStreamRef.current;
              }
            });
            setCamEnabled(!camEnabled);
          }
        } catch (err: any) {
          console.error("Could not enable camera:", err);
          setStatus("Camera not available");
          setCamEnabled(false);
        }
      }
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
          <Button 
            onClick={handleSkip} 
            disabled={!connected}
            className="bg-orange-600 hover:bg-orange-700 text-white"
            title="Skip partner"
          >
            <SkipForward className="w-4 h-4 mr-2" />
            Skip
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
