"use client";

import { ChefHat, CheckCircle2, Truck, Package, Clock } from "lucide-react";
import { Order, OrderStatus } from "@/types/order";
import { cn } from "@/lib/utils";

interface KitchenBoardProps {
  orders: Order[];
  onUpdateStatus: (id: string, status: OrderStatus) => void;
}

type KitchenStatus = "confirmed" | "preparing" | "ready" | "delivered";

const STAGES: {
  status: KitchenStatus;
  label: string;
  Icon: React.ElementType;
  dot: string;
  labelColor: string;
  nextStatus?: KitchenStatus;
  nextLabel?: string;
  btnClass?: string;
}[] = [
  {
    status: "confirmed",
    label: "Confirmed",
    Icon: CheckCircle2,
    dot: "bg-green-400",
    labelColor: "text-green-400",
    nextStatus: "preparing",
    nextLabel: "Start Preparing",
    btnClass: "bg-blue-600 hover:bg-blue-500 text-white",
  },
  {
    status: "preparing",
    label: "Preparing",
    Icon: ChefHat,
    dot: "bg-blue-400",
    labelColor: "text-blue-400",
    nextStatus: "ready",
    nextLabel: "Mark Ready",
    btnClass: "bg-purple-600 hover:bg-purple-500 text-white",
  },
  {
    status: "ready",
    label: "Ready",
    Icon: Package,
    dot: "bg-purple-400",
    labelColor: "text-purple-400",
    nextStatus: "delivered",
    nextLabel: "Mark Delivered",
    btnClass: "bg-zinc-600 hover:bg-zinc-500 text-white",
  },
  {
    status: "delivered",
    label: "Delivered",
    Icon: Truck,
    dot: "bg-zinc-600",
    labelColor: "text-zinc-500",
  },
];

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000 / 60);
  if (diff < 1) return "just now";
  if (diff < 60) return `${diff}m ago`;
  return `${Math.floor(diff / 60)}h ago`;
}

function OrderCard({
  order,
  stage,
  onUpdateStatus,
}: {
  order: Order;
  stage: (typeof STAGES)[number];
  onUpdateStatus: (id: string, status: OrderStatus) => void;
}) {
  return (
    <div className="bg-zinc-800/70 border border-zinc-700/50 rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-white font-semibold text-xs">#{order.id}</span>
        <div className="flex items-center gap-1 text-zinc-600 text-[10px]">
          <Clock size={9} />
          {timeAgo(order.createdAt)}
        </div>
      </div>
      <div className="text-zinc-400 text-[11px]">{order.customerName}</div>
      <div className="space-y-0.5">
        {order.items.map((item, i) => (
          <div key={i} className="text-zinc-300 text-[11px]">
            <span className="text-zinc-600">{item.quantity}×</span> {item.name}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between pt-0.5">
        <span className="text-zinc-600 text-[10px] capitalize">{order.orderType}</span>
        {stage.nextStatus && (
          <button
            onClick={() => onUpdateStatus(order.id, stage.nextStatus!)}
            className={cn(
              "px-2.5 py-1 rounded-md text-[10px] font-semibold transition-colors",
              stage.btnClass
            )}
          >
            {stage.nextLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export function KitchenBoard({ orders, onUpdateStatus }: KitchenBoardProps) {
  const kitchenOrders = orders.filter((o) =>
    (["confirmed", "preparing", "ready", "delivered"] as OrderStatus[]).includes(o.status)
  );

  const activeCount = kitchenOrders.filter((o) => o.status !== "delivered").length;

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <ChefHat size={14} className="text-orange-400" />
          <span className="text-white font-semibold text-sm">Kitchen Board</span>
        </div>
        {activeCount > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 text-xs font-medium border border-orange-500/20">
            {activeCount} active
          </span>
        )}
      </div>

      {/* Stacked sections */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {STAGES.map((stage) => {
          const colOrders = kitchenOrders.filter((o) => o.status === stage.status);
          const { Icon } = stage;
          return (
            <div key={stage.status}>
              {/* Section label */}
              <div className="flex items-center gap-1.5 mb-2">
                <span className={cn("w-2 h-2 rounded-full shrink-0", stage.dot)} />
                <Icon size={12} className={stage.labelColor} />
                <span
                  className={cn(
                    "text-[10px] font-bold uppercase tracking-widest",
                    stage.labelColor
                  )}
                >
                  {stage.label}
                </span>
                <span className="ml-auto text-zinc-700 text-[10px]">
                  {colOrders.length}
                </span>
              </div>

              {colOrders.length === 0 ? (
                <div className="border border-dashed border-zinc-800 rounded-lg py-3 text-center text-zinc-700 text-[11px]">
                  No orders
                </div>
              ) : (
                <div className="space-y-2">
                  {colOrders.map((order) => (
                    <OrderCard
                      key={order.id}
                      order={order}
                      stage={stage}
                      onUpdateStatus={onUpdateStatus}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
