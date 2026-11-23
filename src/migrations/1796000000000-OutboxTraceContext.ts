import { MigrationInterface, QueryRunner } from "typeorm";

// Written by hand: the W3C trace context of the transaction that wrote the event
// ({ traceparent, tracestate? }), so the relay — which publishes it later, from
// another process, in a trace of its own — can make the publish a child of the
// request that caused it. Nullable: rows written outside any span (seed, older
// rows) have none, and the relay then starts a fresh trace.
export class OutboxTraceContext1796000000000 implements MigrationInterface {
    name = 'OutboxTraceContext1796000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "outbox" ADD "trace_context" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "outbox" DROP COLUMN "trace_context"`);
    }
}
