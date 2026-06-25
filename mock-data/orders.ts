import { Order } from "@/types/order";

export const orders: Order[] = [
  {
    id: "1001",
    customerName: "Ali Khan",
    phone: "03001234567",
    total: 1149,
    status: "pending_verification",
    items: [
      { name: "Deal 2 (Dynamite Zinger + Fries + Coke)", quantity: 1, price: 849 },
      { name: "Coke (Regular)", quantity: 1, price: 150 },
    ],
    orderType: "delivery",
    address: "DHA Karachi, Street 12, House 45",
    notes: "Extra ketchup please",
    createdAt: "2026-06-23T10:30:00Z",
  },
  {
    id: "1002",
    customerName: "Ahmed Raza",
    phone: "03111234567",
    total: 849,
    status: "pending_verification",
    items: [
      { name: "Deal 1 (Classic Zinger + Fries + Coke)", quantity: 1, price: 849 },
    ],
    orderType: "delivery",
    address: "Gulshan-e-Iqbal, Block 13, House 7",
    createdAt: "2026-06-23T10:45:00Z",
  },
  {
    id: "1003",
    customerName: "Sara Ahmed",
    phone: "03221234567",
    total: 1298,
    status: "confirmed",
    items: [
      { name: "Classic Zinger", quantity: 2, price: 549 },
      { name: "Regular Fries", quantity: 1, price: 200 },
    ],
    orderType: "delivery",
    address: "Gulshan-e-Iqbal, Block 13, House 7",
    createdAt: "2026-06-23T09:45:00Z",
  },
  {
    id: "1004",
    customerName: "Bilal Siddiqui",
    phone: "03341234567",
    total: 699,
    status: "preparing",
    items: [
      { name: "Cheese Zinger", quantity: 1, price: 699 },
    ],
    orderType: "pickup",
    createdAt: "2026-06-23T09:30:00Z",
  },
  {
    id: "1005",
    customerName: "Fatima Noor",
    phone: "03451234567",
    total: 1499,
    status: "ready",
    items: [
      { name: "Dynamite Zinger", quantity: 2, price: 649 },
      { name: "Coke (Regular)", quantity: 1, price: 150 },
    ],
    orderType: "delivery",
    address: "PECHS, Block 2, House 15",
    createdAt: "2026-06-23T09:00:00Z",
  },
  {
    id: "1006",
    customerName: "Usman Tariq",
    phone: "03561234567",
    total: 549,
    status: "delivered",
    items: [
      { name: "Classic Zinger", quantity: 1, price: 549 },
    ],
    orderType: "pickup",
    createdAt: "2026-06-23T08:30:00Z",
  },
];
