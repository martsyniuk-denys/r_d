import { MigrationInterface, QueryRunner } from "typeorm";

// Written in the generator's shape, then checked against `migrate:generate`, which
// reports only the two long-standing false diffs (see the README).
//
// The UPDATE is the one data step: whoever already sells something is a seller.
// Everybody else stays a buyer, and no account gets a password here — an account
// without one simply cannot log in.
export class AuthRolesRefreshTokens1793349700000 implements MigrationInterface {
    name = 'AuthRolesRefreshTokens1793349700000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "role" text NOT NULL DEFAULT 'buyer'`);
        await queryRunner.query(`ALTER TABLE "users" ADD "password_hash" text`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "users_role_known" CHECK (role IN ('buyer', 'seller', 'admin'))`);
        await queryRunner.query(`UPDATE "users" SET "role" = 'seller' WHERE "id" IN (SELECT DISTINCT "seller_id" FROM "products")`);
        await queryRunner.query(`CREATE TABLE "refresh_tokens" ("id" uuid NOT NULL, "user_id" bigint NOT NULL, "family_id" uuid NOT NULL, "parent_id" uuid, "token_hash" text NOT NULL, "issued_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "used_at" TIMESTAMP WITH TIME ZONE, "revoked_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "refresh_tokens_token_hash_unique" ON "refresh_tokens" ("token_hash") `);
        await queryRunner.query(`CREATE INDEX "idx_refresh_tokens_family" ON "refresh_tokens" ("family_id") `);
        await queryRunner.query(`CREATE TABLE "revoked_access_tokens" ("jti" uuid NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_3d1a8a3c4f4f1b1f7f6e1c2b9a0" PRIMARY KEY ("jti"))`);
        await queryRunner.query(`CREATE INDEX "idx_revoked_access_tokens_expires_at" ON "revoked_access_tokens" ("expires_at") `);
        await queryRunner.query(`ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_5a8e126b7a91b145aa651af5507" FOREIGN KEY ("parent_id") REFERENCES "refresh_tokens"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_5a8e126b7a91b145aa651af5507"`);
        await queryRunner.query(`ALTER TABLE "refresh_tokens" DROP CONSTRAINT "FK_3ddc983c5f7bcf132fd8732c3f4"`);
        await queryRunner.query(`DROP INDEX "public"."idx_revoked_access_tokens_expires_at"`);
        await queryRunner.query(`DROP TABLE "revoked_access_tokens"`);
        await queryRunner.query(`DROP INDEX "public"."idx_refresh_tokens_family"`);
        await queryRunner.query(`DROP INDEX "public"."refresh_tokens_token_hash_unique"`);
        await queryRunner.query(`DROP TABLE "refresh_tokens"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "users_role_known"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_hash"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "role"`);
    }

}
