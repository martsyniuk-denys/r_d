// The broken input of step 3 (architecture), cruised by demo:gates next to src/.
// It sits where a catalog file would (…/src/products/) and reaches into the order
// flow — exactly the import rule catalog-does-not-know-orders forbids.

import { OrdersService } from '../../../../../src/orders/orders.service';

export type CatalogKnowsOrders = OrdersService;
