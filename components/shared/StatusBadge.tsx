import { cn } from "@/lib/utils";
import { OrderStatus } from "@/types/order";

const statusConfig: Record<OrderStatus, { label: string; className: string }> = {
  pending_verification: {
    label: "Pending Verification",
    className: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  },
  confirmed: {
    label: "Confirmed",
    className: "bg-green-500/15 text-green-400 border-green-500/30",
  },
  preparing: {
    label: "Preparing",
    className: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  },
  ready: {
    label: "Ready",
    className: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  },
  delivered: {
    label: "Delivered",
    className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  },
  rejected: {
    label: "Rejected",
    className: "bg-red-500/15 text-red-400 border-red-500/30",
  },
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const config = statusConfig[status];
  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border",
        config.className
      )}
    >
      {config.label}
    </span>
  );
}
