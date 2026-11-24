import { MigrationInterface, QueryRunner } from "typeorm";

// Written by hand, in the shape the generator produces: the coursework's main
// contour, pending → confirmed → paid.
//
//   orders.status          gains 'confirmed' — set by the fulfilment consumer.
//   payment_intents        one per order, the amount frozen at checkout; the
//                          provider's webhook is checked against it, never against
//                          what the webhook says the amount is.
//   payment_events         append-only journal of every webhook that passed the
//                          signature, keyed by the provider's own event id: a
//                          redelivered webhook is an INSERT that finds its row.
//   order_status_history   one row per accepted transition; its id is the SSE
//                          event id, so a reconnect with Last-Event-ID replays
//                          from the database, not from one process's memory.
export class OrderLifecycle1795000000000 implements MigrationInterface {
    name = 'OrderLifecycle1795000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "orders_status_known"`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "orders_status_known" CHECK (status IN ('pending', 'confirmed', 'paid', 'shipped', 'cancelled', 'refunded'))`);
        await queryRunner.query(`CREATE TABLE "payment_intents" ("order_id" bigint NOT NULL, "amount_minor" integer NOT NULL, "currency" text NOT NULL, "status" text NOT NULL DEFAULT 'requires_payment', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "payment_intents_amount_non_negative" CHECK (amount_minor >= 0), CONSTRAINT "payment_intents_currency_known" CHECK (currency IN ('UAH', 'USD', 'EUR')), CONSTRAINT "payment_intents_status_known" CHECK (status IN ('requires_payment', 'succeeded', 'failed')), CONSTRAINT "PK_payment_intents_order_id" PRIMARY KEY ("order_id"))`);
        await queryRunner.query(`CREATE TABLE "payment_events" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "provider_event_id" text NOT NULL, "order_id" bigint NOT NULL, "amount_minor" integer NOT NULL, "currency" text NOT NULL, "outcome" text NOT NULL, "verdict" text NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "payment_events_outcome_known" CHECK (outcome IN ('succeeded', 'failed')), CONSTRAINT "payment_events_verdict_known" CHECK (verdict IN ('applied', 'amount_mismatch', 'ignored')), CONSTRAINT "payment_events_provider_event_unique" UNIQUE ("provider_event_id"), CONSTRAINT "PK_payment_events_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_payment_events_order" ON "payment_events" ("order_id", "id")`);
        await queryRunner.query(`CREATE TABLE "order_status_history" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "order_id" bigint NOT NULL, "status" text NOT NULL, "previous_status" text, "changed_by" text NOT NULL, "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_order_status_history_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_order_status_history_order" ON "order_status_history" ("order_id", "id")`);
        await queryRunner.query(`ALTER TABLE "payment_intents" ADD CONSTRAINT "FK_payment_intents_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        // RESTRICT: the journal of money is not deleted together with an order.
        await queryRunner.query(`ALTER TABLE "payment_events" ADD CONSTRAINT "FK_payment_events_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_status_history" ADD CONSTRAINT "FK_order_status_history_order" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order_status_history" DROP CONSTRAINT "FK_order_status_history_order"`);
        await queryRunner.query(`ALTER TABLE "payment_events" DROP CONSTRAINT "FK_payment_events_order"`);
        await queryRunner.query(`ALTER TABLE "payment_intents" DROP CONSTRAINT "FK_payment_intents_order"`);
        await queryRunner.query(`DROP INDEX "public"."idx_order_status_history_order"`);
        await queryRunner.query(`DROP TABLE "order_status_history"`);
        await queryRunner.query(`DROP INDEX "public"."idx_payment_events_order"`);
        await queryRunner.query(`DROP TABLE "payment_events"`);
        await queryRunner.query(`DROP TABLE "payment_intents"`);
        // A 'confirmed' order has no place in the old schema: it goes back to pending.
        await queryRunner.query(`UPDATE "orders" SET status = 'pending' WHERE status = 'confirmed'`);
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "orders_status_known"`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "orders_status_known" CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled', 'refunded'))`);
    }

}
