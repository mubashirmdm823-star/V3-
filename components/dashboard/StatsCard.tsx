import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

interface StatsCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  accent?: "green" | "yellow" | "blue" | "purple" | "zinc";
  subtitle?: string;
}

const accentMap = {
  green: "text-green-400 bg-green-500/10",
  yellow: "text-yellow-400 bg-yellow-500/10",
  blue: "text-blue-400 bg-blue-500/10",
  purple: "text-purple-400 bg-purple-500/10",
  zinc: "text-zinc-400 bg-zinc-500/10",
};

export function StatsCard({
  title,
  value,
  icon: Icon,
  accent = "green",
  subtitle,
}: StatsCardProps) {
  return (
    <div className="bg-zinc-800 rounded-xl p-5 border border-zinc-700 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-zinc-400 text-sm font-medium">{title}</span>
        <div className={cn("p-2 rounded-lg", accentMap[accent])}>
          <Icon size={16} />
        </div>
      </div>
      <div>
        <div className="text-2xl font-bold text-white">{value}</div>
        {subtitle && (
          <div className="text-xs text-zinc-500 mt-0.5">{subtitle}</div>
        )}
      </div>
    </div>
  );
}
