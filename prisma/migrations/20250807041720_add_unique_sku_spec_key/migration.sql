/*
  Warnings:

  - A unique constraint covering the columns `[sku,spec_key]` on the table `specifications` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX `specifications_sku_spec_key_key` ON `specifications`(`sku`, `spec_key`);
