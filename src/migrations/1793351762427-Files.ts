import { MigrationInterface, QueryRunner } from "typeorm";

// Generated, then trimmed by hand of the two long-standing false diffs (the GIN
// index on products.search_vector and the jobs.payload default — see the README).
// The partial index on PENDING rows is what a cleanup job of abandoned uploads
// scans; files_key_unique is the lookup by object key.

export class Files1793351762427 implements MigrationInterface {
    name = 'Files1793351762427'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "files" ("id" uuid NOT NULL, "key" text NOT NULL, "owner_id" bigint NOT NULL, "status" text NOT NULL DEFAULT 'PENDING', "content_type" text NOT NULL, "size" bigint NOT NULL, "upload_id" text, "part_size" integer, "part_count" integer, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completed_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "files_size_positive" CHECK (size > 0), CONSTRAINT "files_status_known" CHECK (status IN ('PENDING', 'COMPLETED')), CONSTRAINT "PK_6c16b9093a142e0e7613b04a3d9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_files_pending_created_at" ON "files" ("created_at") WHERE status = 'PENDING'`);
        await queryRunner.query(`CREATE INDEX "idx_files_owner_created_at" ON "files" ("owner_id", "created_at") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "files_key_unique" ON "files" ("key") `);
        await queryRunner.query(`ALTER TABLE "files" ADD CONSTRAINT "FK_4bc1db1f4f34ec9415acd88afdb" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "files" DROP CONSTRAINT "FK_4bc1db1f4f34ec9415acd88afdb"`);
        await queryRunner.query(`DROP INDEX "public"."files_key_unique"`);
        await queryRunner.query(`DROP INDEX "public"."idx_files_owner_created_at"`);
        await queryRunner.query(`DROP INDEX "public"."idx_files_pending_created_at"`);
        await queryRunner.query(`DROP TABLE "files"`);
    }

}
