"use client";

import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { Phone, RefreshCw, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { processMessage } from "@/lib/engine/client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "ai" | "customer";
  content: string;
  time: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTime() {
  return new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function parseContent(text: string): React.ReactNode[] {
  return text.split(/(\*[^*\n]+\*)/g).map((seg, i) =>
    seg.startsWith("*") && seg.endsWith("*") ? (
      <strong key={i}>{seg.slice(1, -1)}</strong>
    ) : (
      <span key={i}>{seg}</span>
    )
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function WhatsAppSimulator() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [input, setInput] = useState("");
  const [isFinished, setIsFinished] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  // Opaque — whichever engine is active (config/ai-engine.ts's AI_ENGINE)
  // owns this shape entirely; the simulator only ever threads it through.
  const contextRef = useRef<unknown>(undefined);
  const isFinishedRef = useRef(false);
  const isSendingRef = useRef(false);

  function applyFinished(finished: boolean) {
    isFinishedRef.current = finished;
    setIsFinished(finished);
  }

  function addAI(content: string) {
    setMessages((prev) => [...prev, { id: uid(), role: "ai", content, time: getTime() }]);
  }

  function addCustomer(content: string) {
    setMessages((prev) => [...prev, { id: uid(), role: "customer", content, time: getTime() }]);
  }

  function respond(text: string) {
    if (isTyping || isFinishedRef.current) return;
    addCustomer(text);
    setIsTyping(true);

    setTimeout(async () => {
      const result = await processMessage({ message: text, context: contextRef.current });
      setIsTyping(false);
      addAI(result.reply);
      contextRef.current = result.context;
      if (result.isFinished) applyFinished(true);
    }, 1200);
  }

  function handleSend() {
    const text = input.trim();
    if (!text || isSendingRef.current) return;
    isSendingRef.current = true;
    setInput("");
    respond(text);
    setTimeout(() => { isSendingRef.current = false; }, 400);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSend();
  }

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setIsTyping(true);
    const t = setTimeout(() => {
      setIsTyping(false);
      addAI(
        `👋 *Welcome to Think Food!*\n\nI'm your AI sales assistant. How can I help you today?\n\n📋 View our menu\n🛒 Place an order\n📍 Restaurant info`
      );
    }, 800);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  function reset() {
    setMessages([]);
    setIsTyping(false);
    setInput("");
    applyFinished(false);
    contextRef.current = undefined;
    initialized.current = false;
    setTimeout(() => {
      if (initialized.current) return;
      initialized.current = true;
      setIsTyping(true);
      setTimeout(() => {
        setIsTyping(false);
        addAI(
          `👋 *Welcome to Think Food!*\n\nI'm your AI sales assistant. How can I help you today?\n\n📋 View our menu\n🛒 Place an order\n📍 Restaurant info`
        );
      }, 800);
    }, 30);
  }

  return (
    <div className="flex flex-col h-full bg-[#0b141a]">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-[#202c33] border-b border-[#2a3942]">
        <div className="w-9 h-9 rounded-full bg-[#25d366] flex items-center justify-center shrink-0 text-[#111b21] font-bold text-sm select-none">
          TF
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[#e9edef] font-semibold text-sm leading-tight">Think Food</div>
          <div className="text-[#25d366] text-xs">Online</div>
        </div>
        <div className="flex items-center gap-3 text-[#8696a0]">
          <Phone size={17} />
          <button
            onClick={reset}
            title="Reset conversation"
            className="hover:text-[#e9edef] transition-colors"
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        className="flex-1 overflow-y-auto overscroll-contain px-3 py-3 space-y-0.5"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {messages.map((msg, idx) => {
          const isFirst = idx === 0 || messages[idx - 1].role !== msg.role;
          return (
            <div
              key={msg.id}
              className={cn(
                "flex",
                msg.role === "customer" ? "justify-end" : "justify-start",
                isFirst && idx > 0 ? "mt-3" : "mt-0.5"
              )}
            >
              <div
                className={cn(
                  "relative max-w-[82%] px-3 pt-1.5 pb-1 text-[13px] leading-[1.45] shadow-sm",
                  msg.role === "customer"
                    ? "bg-[#005c4b] text-[#e9edef] rounded-[7px] rounded-tr-[2px]"
                    : "bg-[#202c33] text-[#e9edef] rounded-[7px] rounded-tl-[2px]"
                )}
              >
                <p className="whitespace-pre-line">{parseContent(msg.content)}</p>
                <span
                  className={cn(
                    "block text-[10px] mt-0.5 select-none",
                    msg.role === "customer" ? "text-right text-[#8696a0]" : "text-[#8696a0]"
                  )}
                >
                  {msg.time}
                </span>
              </div>
            </div>
          );
        })}

        {isTyping && (
          <div className="flex justify-start mt-2">
            <div className="bg-[#202c33] rounded-[7px] rounded-tl-[2px] px-4 py-3">
              <div className="flex gap-1 items-center">
                {[0, 160, 320].map((d) => (
                  <span
                    key={d}
                    className="w-[6px] h-[6px] rounded-full bg-[#8696a0] animate-bounce"
                    style={{ animationDelay: `${d}ms` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input bar */}
      <div
        className="shrink-0 bg-[#202c33] border-t border-[#2a3942] px-3 flex items-center gap-2"
        style={{
          paddingTop: "8px",
          paddingBottom: "max(8px, env(safe-area-inset-bottom))",
        }}
      >
        {isFinished ? (
          <p className="flex-1 text-center text-[#8696a0] text-xs py-1">
            Order submitted — tap <RefreshCw size={11} className="inline" /> to start a new chat
          </p>
        ) : (
          <>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Type a message"
              disabled={isTyping}
              className="flex-1 bg-[#2a3942] text-[#e9edef] placeholder-[#8696a0] px-4 py-2 rounded-full outline-none border border-transparent focus:border-[#25d366]/30 transition-colors disabled:opacity-50"
              style={{ fontSize: "16px" }}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isTyping}
              className="w-9 h-9 rounded-full bg-[#25d366] flex items-center justify-center shrink-0 text-[#111b21] disabled:opacity-40 hover:bg-[#22c55e] active:bg-[#16a34a] transition-colors touch-manipulation"
            >
              <Send size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
