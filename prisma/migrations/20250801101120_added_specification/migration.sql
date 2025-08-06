/*
  Warnings:

  - You are about to drop the `test` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE `test`;

-- CreateTable
CREATE TABLE `specification` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `part_no` VARCHAR(191) NOT NULL,
    `spec_key` VARCHAR(191) NOT NULL,
    `spec_value` VARCHAR(191) NOT NULL,
    `shopify_product_id` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
