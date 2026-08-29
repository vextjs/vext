import type { OrderStatus } from "../../types/shared/order.js";

/** Runtime values shared by order services and routes. */
export const ORDER_STATUS = {
  PENDING: "pending",
  PAID: "paid",
} as const satisfies Record<"PENDING" | "PAID", OrderStatus>;
