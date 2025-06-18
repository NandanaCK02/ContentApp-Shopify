/*
  Warnings:

  - The primary key for the `Faq` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Faq" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL
);
INSERT INTO "new_Faq" ("answer", "id", "question", "resourceId", "resourceType") SELECT "answer", "id", "question", "resourceId", "resourceType" FROM "Faq";
DROP TABLE "Faq";
ALTER TABLE "new_Faq" RENAME TO "Faq";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
