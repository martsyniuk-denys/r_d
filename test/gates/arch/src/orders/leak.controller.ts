// The second broken input of step 3 (architecture): a controller that runs the
// checkout transaction itself instead of asking its service — exactly the import
// rule controllers-stay-thin forbids.

import { placeOrder } from '../../../../../src/orders/place-order';

export type ControllerRunsCheckout = typeof placeOrder;
