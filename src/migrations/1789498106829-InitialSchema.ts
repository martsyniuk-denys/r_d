import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1789498106829 implements MigrationInterface {
    name = 'InitialSchema1789498106829'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "users" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "email" text NOT NULL, "display_name" text NOT NULL, "country" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "users_country_is_iso2" CHECK (country ~ '^[A-Z]{2}$'), CONSTRAINT "users_display_name_not_empty" CHECK (length(display_name) > 0), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "users_email_unique" ON "users" ("email") `);
        await queryRunner.query(`INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES ($1, $2, $3, $4, $5, $6)`, ["marketplace","public","products","GENERATED_COLUMN","search_vector","to_tsvector('simple', name || ' ' || description)"]);
        await queryRunner.query(`CREATE TABLE "products" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "seller_id" bigint NOT NULL, "name" text NOT NULL, "description" text NOT NULL DEFAULT '', "price_minor" integer NOT NULL, "currency" text NOT NULL, "status" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', name || ' ' || description)) STORED NOT NULL, CONSTRAINT "products_status_known" CHECK (status IN ('draft', 'active', 'archived')), CONSTRAINT "products_currency_known" CHECK (currency IN ('UAH', 'USD', 'EUR')), CONSTRAINT "products_price_non_negative" CHECK (price_minor >= 0), CONSTRAINT "products_name_not_empty" CHECK (length(name) > 0), CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "order_items" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "order_id" bigint NOT NULL, "product_id" bigint NOT NULL, "qty" integer NOT NULL, "unit_price_minor" integer NOT NULL, CONSTRAINT "order_items_order_product_unique" UNIQUE ("order_id", "product_id"), CONSTRAINT "order_items_unit_price_non_negative" CHECK (unit_price_minor >= 0), CONSTRAINT "order_items_qty_positive" CHECK (qty > 0), CONSTRAINT "PK_005269d8574e6fac0493715c308" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "orders" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "buyer_id" bigint NOT NULL, "status" text NOT NULL, "total_minor" integer NOT NULL, "currency" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "orders_status_known" CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled', 'refunded')), CONSTRAINT "orders_currency_known" CHECK (currency IN ('UAH', 'USD', 'EUR')), CONSTRAINT "orders_total_non_negative" CHECK (total_minor >= 0), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_orders_refunded_created_at" ON "orders" ("created_at" DESC) WHERE status = 'refunded'`);
        await queryRunner.query(`CREATE INDEX "idx_orders_buyer_created_at" ON "orders" ("buyer_id", "created_at" DESC)`);
        await queryRunner.query(`CREATE INDEX "idx_users_email_lower" ON "users" (lower(email))`);
        await queryRunner.query(`CREATE INDEX "idx_products_search_vector" ON "products" USING GIN ("search_vector")`);
        await queryRunner.query(`ALTER TABLE "products" ADD CONSTRAINT "FK_425ee27c69d6b8adc5d6475dcfe" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "FK_145532db85752b29c57d2b7b1f1" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "order_items" ADD CONSTRAINT "FK_9263386c35b6b242540f9493b00" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "orders" ADD CONSTRAINT "FK_5e90e93d0e036c3fadbaefa4d0a" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "orders" DROP CONSTRAINT "FK_5e90e93d0e036c3fadbaefa4d0a"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "FK_9263386c35b6b242540f9493b00"`);
        await queryRunner.query(`ALTER TABLE "order_items" DROP CONSTRAINT "FK_145532db85752b29c57d2b7b1f1"`);
        await queryRunner.query(`ALTER TABLE "products" DROP CONSTRAINT "FK_425ee27c69d6b8adc5d6475dcfe"`);
        await queryRunner.query(`DROP INDEX "public"."idx_products_search_vector"`);
        await queryRunner.query(`DROP INDEX "public"."idx_users_email_lower"`);
        await queryRunner.query(`DROP INDEX "public"."idx_orders_buyer_created_at"`);
        await queryRunner.query(`DROP INDEX "public"."idx_orders_refunded_created_at"`);
        await queryRunner.query(`DROP TABLE "orders"`);
        await queryRunner.query(`DROP TABLE "order_items"`);
        await queryRunner.query(`DROP TABLE "products"`);
        await queryRunner.query(`DELETE FROM "typeorm_metadata" WHERE "type" = $1 AND "name" = $2 AND "database" = $3 AND "schema" = $4 AND "table" = $5`, ["GENERATED_COLUMN","search_vector","marketplace","public","products"]);
        await queryRunner.query(`DROP INDEX "public"."users_email_unique"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }

}
