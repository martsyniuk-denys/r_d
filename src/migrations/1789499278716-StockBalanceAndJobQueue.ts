import { MigrationInterface, QueryRunner } from "typeorm";

export class StockBalanceAndJobQueue1789499278716 implements MigrationInterface {
    name = 'StockBalanceAndJobQueue1789499278716'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "jobs" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "type" text NOT NULL, "payload" jsonb NOT NULL DEFAULT '{}'::jsonb, "status" text NOT NULL DEFAULT 'pending', "processed" integer NOT NULL DEFAULT '0', "attempts" integer NOT NULL DEFAULT '0', "processed_by" text, "order_id" bigint, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "processed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "jobs_processed_non_negative" CHECK (processed >= 0), CONSTRAINT "jobs_status_known" CHECK (status IN ('pending', 'done', 'failed')), CONSTRAINT "PK_cf0a6c42b72fcc7f7c237def345" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_jobs_pending" ON "jobs" ("id") WHERE status = 'pending'`);
        await queryRunner.query(`ALTER TABLE "users" ADD "balance_minor" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "products" ADD "stock" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "users_balance_non_negative" CHECK (balance_minor >= 0)`);
        await queryRunner.query(`ALTER TABLE "products" ADD CONSTRAINT "products_stock_non_negative" CHECK (stock >= 0)`);
        await queryRunner.query(`ALTER TABLE "jobs" ADD CONSTRAINT "FK_2cb9942b3a4fd4674ebb20406ff" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "FK_2cb9942b3a4fd4674ebb20406ff"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "products_stock_non_negative"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "users_balance_non_negative"`);
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "stock"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "balance_minor"`);
        await queryRunner.query(`DROP INDEX "public"."idx_jobs_pending"`);
        await queryRunner.query(`DROP TABLE "jobs"`);
    }

}
