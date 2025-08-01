/*
  Warnings:

  - You are about to drop the column `isActive` on the `test` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `test` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX `test_email_key` ON `test`;

-- AlterTable
ALTER TABLE `test` DROP COLUMN `isActive`,
    DROP COLUMN `updatedAt`;
