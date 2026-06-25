"use client";

import { CheckCircle, Phone, XCircle, CheckCircle2, Clock, MapPin, Package } from "lucide-react";
import { Order } from "@/types/order";
import { StatusBadge } from "@/components/shared/StatusBadge";

interface AdminDashboardProps {
  orders: Order[];
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000 / 60);
  if (diff < 1) return "just now";
  if (diff < 60) return `${diff}m ago`;
  return `${Math.floor(diff / 60)}h ago`;
}

function PendingCard({
  order,
  onConfirm,
  onReject,
}: {
  order: Order;
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <div className="bg-zinc-800/60 border border-yellow-500/20 rounded-xl p-4 space-y-3">
      {/* Order header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-white font-bold text-sm">#{order.id}</span>
            <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse shrink-0" />
          </div>
          <div className="text-zinc-400 text-xs mt-0.5">{order.customerName}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-white font-bold text-sm">
            PKR {order.total.toLocaleString()}
          </div>
          <div className="flex items-center gap-1 text-zinc-600 text-[10px] justify-end mt-0.5">
            <Clock size={9} />
            {timeAgo(order.createdAt)}
          </div>
        </div>
      </div>

      {/* Customer info */}
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-zinc-400 text-xs">
          <Phone size={11} className="shrink-0" />
          {order.phone}
        </div>
        <div className="flex items-center gap-1.5 text-zinc-400 text-xs">
          <Package size={11} className="shrink-0" />
          <span className="capitalize">{order.orderType}</span>
        </div>
        {order.address && (
          <div className="flex items-start gap-1.5 text-zinc-400 text-xs">
            <MapPin size={11} className="shrink-0 mt-0.5" />
            {order.address}
          </div>
        )}
      </div>

      {/* Items */}
      <div className="bg-zinc-700/40 rounded-lg px-3 py-2 space-y-1">
        {order.items.map((item, i) => (
          <div key={i} className="flex justify-between text-xs">
            <span className="text-zinc-300">
              {item.quantity}x {item.name}
            </span>
            <span className="text-zinc-500">
              {item.price > 0 ? `PKR ${(item.price * item.quantity).toLocaleString()}` : "Free"}
            </span>
          </div>
        ))}
        {order.notes && (
          <div className="text-[10px] text-zinc-500 border-t border-zinc-600/50 pt-1 mt-1">
            Note: {order.notes}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <a
          href={`tel:${order.phone}`}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs transition-colors"
        >
          <Phone size={11} />
          Call
        </a>
        <button
          onClick={() => onConfirm(order.id)}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-semibold transition-colors"
        >
          <CheckCircle2 size={12} />
          Confirm Order
        </button>
        <button
          onClick={() => onReject(order.id)}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/30 text-red-400 text-xs transition-colors"
        >
          <XCircle size={12} />
          Reject
        </button>
      </div>
    </div>
  );
}

export function AdminDashboard({ orders, onConfirm, onReject }: AdminDashboardProps) {
  const pending = orders.filter((o) => o.status === "pending_verification");
  const recent = [...orders]
    .filter((o) => o.status !== "pending_verification")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 6);

  return (
    <div className="flex flex-col h-full">
      {/* Panel header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-yellow-400" />
          <span className="text-white font-semibold text-sm">Pending Verification</span>
        </div>
        {pending.length > 0 ? (
          <span className="px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 text-xs font-medium border border-yellow-500/20">
            {pending.length} waiting
          </span>
        ) : (
          <span className="text-zinc-600 text-xs">All clear</span>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Pending orders */}
        {pending.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <CheckCircle size={28} className="text-green-500 mb-2" />
            <p className="text-zinc-400 text-sm font-medium">All verified</p>
            <p className="text-zinc-600 text-xs mt-1">
              New WhatsApp orders appear here
            </p>
          </div>
        ) : (
          pending.map((order) => (
            <PendingCard
              key={order.id}
              order={order}
              onConfirm={onConfirm}
              onReject={onReject}
            />
          ))
        )}

        {/* Recent orders mini-list */}
        {recent.length > 0 && (
          <div className="pt-1">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600 px-1 mb-2">
              Recent Orders
            </div>
            <div className="space-y-1">
              {recent.map((o) => (
                <div
                  key={o.id}
                  className="flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-800/40 hover:bg-zinc-800/70 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-zinc-500 text-xs shrink-0">#{o.id}</span>
                    <span className="text-zinc-300 text-xs truncate">{o.customerName}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-zinc-600 text-xs">
                      PKR {o.total.toLocaleString()}
                    </span>
                    <StatusBadge status={o.status} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
