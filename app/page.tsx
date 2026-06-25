import { WhatsAppSimulator } from "@/components/whatsapp/WhatsAppSimulator";

export default function Home() {
  return (
    <div className="flex flex-col bg-zinc-950 text-white" style={{ height: "100dvh" }}>
      <header className="shrink-0 bg-[#111827] border-b border-zinc-800/60 px-5 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[#25d366] flex items-center justify-center shrink-0">
            <span className="text-[#111827] font-black text-[10px] tracking-tight select-none">
              TF
            </span>
          </div>
          <span className="font-bold text-white text-sm">Think Food AI</span>
          <span className="text-[10px] text-zinc-600 font-normal">Client Demo</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
            Live Demo
          </span>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex justify-center bg-zinc-950">
        <div className="w-full max-w-[440px] min-h-0 flex flex-col">
          <WhatsAppSimulator />
        </div>
      </div>
    </div>
  );
}
