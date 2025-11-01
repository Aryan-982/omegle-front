"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";

export default function Home() {
  const [interest, setInterest] = useState("");
  const [interests, setInterests] = useState<string[]>([]);
  const router = useRouter();

  const handleAddInterest = () => {
    if (interest.trim() !== "" && !interests.includes(interest.trim())) {
      setInterests([...interests, interest.trim()]);
      setInterest("");
    }
  };

  const handleRemoveInterest = (item: string) => {
    setInterests(interests.filter((i) => i !== item));
  };

  const handleStart = () => {
    const interestQuery = interests.join(",");
    router.push(`/chat?interest=${encodeURIComponent(interestQuery)}`);
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-[#0C2B4E] via-[#1A3D64] to-[#1D546C] text-white p-6">
      <motion.h1
        initial={{ opacity: 0, y: -30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="text-4xl font-bold mb-6"
      >
        Omegle ki copy
      </motion.h1>

      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center bg-white/10 backdrop-blur-md rounded-2xl p-6 shadow-lg w-full max-w-md"
      >
        <div className="flex gap-2 w-full">
          <Input
            placeholder="Enter your interest..."
            value={interest}
            onChange={(e) => setInterest(e.target.value)}
            className="flex-1 text-black bg-white/90 rounded-lg"
          />
          <Button
            onClick={handleAddInterest}
            className="bg-[#F4F4F4] text-[#0C2B4E] font-semibold hover:bg-[#1A3D64] hover:text-white transition-all duration-300"
          >
            + Add
          </Button>
        </div>

        <div className="mt-4 w-full flex flex-wrap gap-2 justify-center">
          <AnimatePresence>
            {interests.map((item) => (
              <motion.div
                key={item}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.5 }}
                transition={{ duration: 0.3 }}
                className="flex items-center gap-2 bg-[#F4F4F4] text-[#0C2B4E] px-3 py-1 rounded-full shadow-sm hover:scale-105 cursor-pointer"
                onClick={() => handleRemoveInterest(item)}
              >
                <span>{item}</span>
                <span className="text-sm text-[#1A3D64] font-bold">×</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <Button
          onClick={handleStart}
          className="mt-6 bg-[#1A3D64] hover:bg-[#1D546C] text-white font-semibold w-full transition-all duration-300 shadow-md"
        >
          Start Chat
        </Button>
      </motion.div>

      <p className="mt-6 text-sm opacity-80">
        Add some interests and find your perfect stranger 👀
      </p>
    </main>
  );
}
