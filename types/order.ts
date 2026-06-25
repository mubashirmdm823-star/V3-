export type OrderStatus =
  | "pending_verification"
  | "confirmed"
  | "preparing"
  | "ready"
  | "delivered"
  | "rejected";

export type OrderType = "delivery" | "pickup";

export interface OrderItem {
  name: string;
  quantity: number;
  price: number;
}

export interface Order {
  id: string;
  customerName: string;
  phone: string;
  total: number;
  status: OrderStatus;
  items: OrderItem[];
  orderType: OrderType;
  address?: string;
  notes?: string;
  createdAt: string;
}
