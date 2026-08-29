import { ORDER_STATUS } from "../constants/services/order-status.js";
import type { OrderRepository } from "../types/server/services/order.js";
import type { OrderDto } from "../types/shared/order.js";

/** Service used to verify support-file ownership boundaries. */
export default class OrderService {
  /** Return the runtime status imported from src/constants/services. */
  currentStatus(): OrderDto["status"] {
    return ORDER_STATUS.PENDING;
  }

  /** Load one order through a server-only repository contract. */
  async findById(
    repository: OrderRepository,
    id: string,
  ): Promise<OrderDto | null> {
    return repository.findById(id);
  }
}
