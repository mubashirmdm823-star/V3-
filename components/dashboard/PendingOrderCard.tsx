"use client";

import { Phone, CheckCircle, XCircle, Clock, MapPin, Package } from "lucide-react";
import { Order } from "@/types/order";

interface PendingOrderCardProps {
  order: Order;
  onConfirm: (id: string) => void;
  onReject: (id: string) => void;
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000 / 60);
  if (diff < 1) return "just now";
  if (diff < 60) return `${diff}m ago`;
  return `${Math.floor(diff / 60)}h ago`;
}

export function PendingOrderCard({ order, onConfirm, onReject }: PendingOrderCardProps) {
  return (
    <div className="bg-zinc-800 border border-yellow-500/20 rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-white font-semibold">#{order.id}</span>
            <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
          </div>
          <div className="text-zinc-400 text-sm mt-0.5">{order.customerName}</div>
        </div>
        <div className="text-right">
          <div className="text-white font-bold">PKR {order.total.toLocaleString()}</div>
          <div className="flex items-center gap-1 text-zinc-500 text-xs mt-0.5 justify-end">
            <Clock size={11} />
            {timeAgo(order.createdAt)}
          </div>
        </div>
      </div>

      {/* Details */}
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center gap-2 text-zinc-400">
          <Phone size={13} className="shrink-0" />
          <span>{order.phone}</span>
        </div>
        <div className="flex items-center gap-2 text-zinc-400">
          <Package size={13} className="shrink-0" />
          <span className="capitalize">{order.orderType}</span>
        </div>
        {order.address && (
          <div className="flex items-start gap-2 text-zinc-400">
            <MapPin size={13} className="shrink-0 mt-0.5" />
            <span>{order.address}</span>
          </div>
        )}
      </div>

      {/* Items */}
      <div className="bg-zinc-700/50 rounded-lg p-3 space-y-1">
        {order.items.map((item, i) => (
          <div key={i} className="flex justify-between text-sm">
            <span className="text-zinc-300">
              {item.quantity}x {item.name}
            </span>
            <span className="text-zinc-400">
              PKR {(item.price * item.quantity).toLocaleString()}
            </span>
          </div>
        ))}
        {order.notes && (
          <div className="text-xs text-zinc-500 pt-1 border-t border-zinc-600 mt-1">
            Note: {order.notes}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <a
          href={`tel:${order.phone}`}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-sm transition-colors"
        >
          <Phone size={14} />
          Call Customer
        </a>
        <button
          onClick={() => onConfirm(order.id)}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-medium transition-colors"
        >
          <CheckCircle size={14} />
          Confirm Order
        </button>
        <button
          onClick={() => onReject(order.id)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-400 text-sm transition-colors"
        >
          <XCircle size={14} />
          Reject
        </button>
      </div>
    </div>
  );
}
