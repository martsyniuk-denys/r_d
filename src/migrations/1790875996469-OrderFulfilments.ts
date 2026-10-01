import { MigrationInterface, QueryRunner } from "typeorm";

// Generated, then trimmed by hand: the generator also wanted to drop the GIN index
// on products.search_vector and to re-set the jobs.payload default — the same two
// false diffs it reports since the initial schema (see the README), not changes.
export class OrderFulfilments1790875996469 implements MigrationInterface {
    name = 'OrderFulfilments1790875996469'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "order_fulfilments" ("event_id" text NOT NULL, "order_id" bigint NOT NULL, "line_count" integer NOT NULL, "total_minor" integer NOT NULL, "handled_by" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_cf8c8f695b20b43b5b89fda1e52" PRIMARY KEY ("event_id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "order_fulfilments_order_unique" ON "order_fulfilments" ("order_id") `);
        await queryRunner.query(`ALTER TABLE "order_fulfilments" ADD CONSTRAINT "FK_998345db2a7e8e35ab569830076" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order_fulfilments" DROP CONSTRAINT "FK_998345db2a7e8e35ab569830076"`);
        await queryRunner.query(`DROP INDEX "public"."order_fulfilments_order_unique"`);
        await queryRunner.query(`DROP TABLE "order_fulfilments"`);
    }

}
