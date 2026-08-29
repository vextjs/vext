import type { OrderDto } from "../../shared/order.js";

/** Server-only repository contract shared by backend consumers. */
export interface OrderRepository {
  findById(id: string): Promise<OrderDto | null>;
}
