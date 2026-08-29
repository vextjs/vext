/** DTO status safe to share with browser and server consumers. */
export type OrderStatus = "pending" | "paid";

/** Cross-end order DTO. */
export interface OrderDto {
  id: string;
  status: OrderStatus;
}
