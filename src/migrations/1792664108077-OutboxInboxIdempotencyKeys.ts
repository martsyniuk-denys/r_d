import { MigrationInterface, QueryRunner } from "typeorm";

// Generated, then trimmed by hand: the generator also wanted to drop the GIN index
// on products.search_vector and to re-set the jobs.payload default — the same two
// false diffs it reports since the initial schema (see the README), not changes.
//
// outbox has no foreign key to orders on purpose: it is a log of what was said,
// read by a relay (and later by Debezium) that knows nothing about the domain,
// and an event must be able to outlive the row it was about.
export class OutboxInboxIdempotencyKeys1792664108077 implements MigrationInterface {
    name = 'OutboxInboxIdempotencyKeys1792664108077'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "idempotency_keys" ("buyer_id" bigint NOT NULL, "key" text NOT NULL, "request_hash" text NOT NULL, "order_id" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0280cf86858b9a72b225b5c13c3" PRIMARY KEY ("buyer_id", "key"))`);
        await queryRunner.query(`CREATE TABLE "outbox" ("id" uuid NOT NULL, "aggregate_type" text NOT NULL, "aggregate_id" text NOT NULL, "type" text NOT NULL, "payload" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "outbox_attempts_non_negative" CHECK (attempts >= 0), CONSTRAINT "PK_340ab539f309f03bdaa14aa7649" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_outbox_unpublished" ON "outbox" ("created_at", "id") WHERE published_at IS NULL`);
        await queryRunner.query(`CREATE TABLE "processed_messages" ("message_id" text NOT NULL, "consumer" text NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d4853eee97acfc588e49f9290d1" PRIMARY KEY ("message_id", "consumer"))`);
        await queryRunner.query(`ALTER TABLE "idempotency_keys" ADD CONSTRAINT "FK_6379310d751cb7002895470410a" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "idempotency_keys" ADD CONSTRAINT "FK_446856502ff1075430219299f33" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "idempotency_keys" DROP CONSTRAINT "FK_446856502ff1075430219299f33"`);
        await queryRunner.query(`ALTER TABLE "idempotency_keys" DROP CONSTRAINT "FK_6379310d751cb7002895470410a"`);
        await queryRunner.query(`DROP TABLE "processed_messages"`);
        await queryRunner.query(`DROP INDEX "public"."idx_outbox_unpublished"`);
        await queryRunner.query(`DROP TABLE "outbox"`);
        await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    }

}
