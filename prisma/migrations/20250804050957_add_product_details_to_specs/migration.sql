/*
  Warnings:

  - Added the required column `product_handle` to the `specification` table without a default value. This is not possible if the table is not empty.
  - Added the required column `product_title` to the `specification` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `specification` ADD COLUMN `product_handle` VARCHAR(191) NOT NULL,
    ADD COLUMN `product_title` VARCHAR(191) NOT NULL;
